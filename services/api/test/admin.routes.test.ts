// MER-64: admin and ops routes. Admin JWT only; transaction routes return unsigned multisig txs.
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { K } from "../../shared/src/keys.js";
import { decodeIx, PLACEHOLDER_BLOCKHASH } from "../src/chain/admin.js";
import { PROGRAM_ID } from "../src/chain/idl.js";
import { tickerDayPda } from "../src/chain/pdas.js";
import { adminChain, adminVault, auth, Clock, makeApp, token, wallet } from "./helpers/app.js";
import { DATE, M680, M720, replay, T, U } from "./helpers/day.js";
import { startTestDb, TestDb } from "./helpers/pg.js";
import { startTestRedis, TestRedis } from "./helpers/redis.js";

const ADMIN = wallet().pubkey;

describe("admin routes", () => {
  let r: TestRedis | null;
  let db: TestDb | null;
  let redis: Redis;
  const clock: Clock = { t: T.open + 3600 };
  let app: FastifyInstance;
  beforeAll(async () => {
    r = await startTestRedis();
    db = await startTestDb();
  });
  afterAll(async () => {
    await app?.close();
    await r?.stop();
    await db?.stop();
  });
  beforeEach(async () => {
    if (!r) return;
    await r.flush();
    redis = r.client();
    clock.t = T.open + 3600;
    await app?.close();
    app = await makeApp(redis, db?.pool ?? null, clock, { adminSigners: new Set([ADMIN]) });
    if (db) await db.pool.query("TRUNCATE admin_audit, alerts, job_runs");
  });
  const post = async (url: string, body: unknown = {}, t = token(ADMIN, clock, { adm: true })) => {
    const res = await app.inject({ method: "POST", url, headers: auth(t), payload: body as object });
    return { status: res.statusCode, body: res.json() };
  };
  const get = async (url: string, t = token(ADMIN, clock, { adm: true })) => {
    const res = await app.inject({ method: "GET", url, headers: auth(t) });
    return { status: res.statusCode, body: res.json() };
  };

  /** The returned tx is unsigned, paid by the multisig vault, and decodes to `name`. */
  function decodeUnsigned(body: { transaction: string; multisig: { vault: string; instructions: { programId: string; data: string }[] } }, name: string) {
    const tx = VersionedTransaction.deserialize(Buffer.from(body.transaction, "base64"));
    expect(tx.signatures.every((s) => s.every((b) => b === 0))).toBe(true);
    expect(tx.message.staticAccountKeys[0]!.equals(adminVault)).toBe(true);
    expect(tx.message.recentBlockhash).toBe(PLACEHOLDER_BLOCKHASH);
    expect(body.multisig.vault).toBe(adminVault.toBase58());
    expect(body.multisig.instructions).toHaveLength(1);
    const ix = body.multisig.instructions[0]!;
    expect(ix.programId).toBe(PROGRAM_ID.toBase58());
    const d = decodeIx(Buffer.from(ix.data, "base64"));
    expect(d?.name).toBe(name);
    return { tx, ix, data: d!.data as Record<string, unknown> };
  }

  it("API-12 a non-admin JWT gets 403; an admin gets an unsigned multisig pause tx", async () => {
    if (!r) return;
    expect((await post("/v1/admin/tx/pause", {}, token(U.bob, clock))).status).toBe(403);
    expect((await post("/v1/admin/tx/pause", {}, token(U.bob, clock))).body.error.code).toBe("UNAUTHORIZED");
    // A forged adm claim for a wallet outside the signer set is still refused.
    expect((await post("/v1/admin/tx/pause", {}, token(U.bob, clock, { adm: true }))).status).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/admin/tx/pause" })).statusCode).toBe(401);
    const ok = await post("/v1/admin/tx/pause");
    expect(ok.status).toBe(200);
    const { ix } = decodeUnsigned(ok.body, "pause");
    expect((ix as unknown as { accounts: { pubkey: string; isSigner: boolean }[] }).accounts[0]).toEqual({ pubkey: adminVault.toBase58(), isSigner: true, isWritable: false });
    decodeUnsigned((await post("/v1/admin/tx/unpause")).body, "unpause");
  });

  it("SIWS marks admin signers in the token", async () => {
    if (!r) return;
    const w = wallet();
    await app.close();
    app = await makeApp(redis, db?.pool ?? null, clock, { adminSigners: new Set([w.pubkey]) });
    const n = (await app.inject({ method: "POST", url: "/v1/auth/siws/nonce", payload: { owner: w.pubkey } })).json();
    const v = (await app.inject({ method: "POST", url: "/v1/auth/siws/verify", payload: { owner: w.pubkey, message: n.message, signature: w.signMessage(n.message) } })).json();
    expect(v.admin).toBe(true);
    expect((await post("/v1/admin/tx/pause", {}, v.token)).status).toBe(200);
  });

  it("ADM-06 override-settle is refused before close + override delay and once the ticker-day is recorded; requires a reason", async () => {
    if (!r) return;
    await replay(redis, "void 720");
    const body = { symbol: "META", date: "2026-11-25", priceRaw: "68512000", expo: -5, reason: "Pyth outage" };
    clock.t = T.close + 600; // close + 10 min
    const early = await post("/v1/admin/tx/override-settle", body);
    expect(early.status).toBe(409);
    expect(early.body.error).toMatchObject({ code: "OVERRIDE_TOO_EARLY", details: { earliestUnix: T.close + 1800 } });
    expect(early.body.transaction).toBeUndefined();
    expect((await post("/v1/admin/tx/override-settle", { ...body, reason: "" })).body.error.code).toBe("VALIDATION");
    clock.t = T.close + 1800;
    const ok = await post("/v1/admin/tx/override-settle", body);
    expect(ok.status).toBe(200);
    const { data, ix } = decodeUnsigned(ok.body, "admin_settle");
    expect(String(data.price)).toBe("68512000");
    expect(data.expo).toBe(-5);
    expect((ix as unknown as { accounts: { pubkey: string }[] }).accounts[2]!.pubkey).toBe(tickerDayPda("META", DATE).toBase58());
    await replay(redis, "record close");
    const late = await post("/v1/admin/tx/override-settle", body);
    expect(late.body.error).toMatchObject({ code: "ALREADY_RECORDED", details: { status: "PROVISIONAL" } });
  });

  it("add-strike, void-market and resolve-dispute decode correctly and check state first", async () => {
    if (!r) return;
    await replay(redis, "void 720");
    const add = await post("/v1/admin/tx/add-strike", { symbol: "META", date: "2026-11-25", strikeCents: 68550 });
    expect(add.status).toBe(200);
    expect(String(decodeUnsigned(add.body, "add_strike").data.strike_cents)).toBe("68550");
    expect((await post("/v1/admin/tx/add-strike", { symbol: "META", date: "2026-11-25", strikeCents: 68000 })).body.error.code).toBe("VALIDATION");
    const v = await post("/v1/admin/tx/void-market", { marketId: M680 });
    expect(v.status).toBe(200);
    decodeUnsigned(v.body, "void_market");
    expect((await post("/v1/admin/tx/void-market", { marketId: M720 })).body.error.message).toContain("already VOID");
    expect((await post("/v1/admin/tx/resolve-dispute", { symbol: "META", date: "2026-11-25", result: "UPHELD" })).body.error.code).toBe("VALIDATION");
    await replay(redis, "dispute");
    clock.t = T.close + 900;
    const up = await post("/v1/admin/tx/resolve-dispute", { symbol: "META", date: "2026-11-25", result: "UPHELD" });
    expect(up.status).toBe(200);
    expect(decodeUnsigned(up.body, "resolve_dispute").data).toEqual({ resolution: { Uphold: {} } });
    const fix = await post("/v1/admin/tx/resolve-dispute", { symbol: "META", date: "2026-11-25", result: "CORRECTED", priceRaw: "68512000", expo: -5, evidence: "NOCP 685.12" });
    const d = decodeUnsigned(fix.body, "resolve_dispute").data as { resolution: { Correct: { price: { toString(): string }; expo: number } } };
    expect([d.resolution.Correct.price.toString(), d.resolution.Correct.expo]).toEqual(["68512000", -5]);
    const disputer = JSON.parse((await redis.hget(K.tday("META", DATE), "dispute"))!).by;
    expect(fix.body.summary.disputer).toBe(disputer);
    expect(fix.body.multisig.instructions[0].accounts.map((a: { pubkey: string }) => a.pubkey)).toContain(adminChain.feeVault.toBase58());
    expect(new PublicKey(disputer).toBase58()).toBe(U.disputer);
  });

  it("job rerun accepts idempotent jobs only and queues them for Automation", async () => {
    if (!r) return;
    const bad = await post("/v1/admin/jobs/PAUSE/run", { date: "2026-11-25" });
    expect(bad).toMatchObject({ status: 409, body: { error: { code: "NOT_RERUNNABLE" } } });
    expect(await redis.xlen(K.jobreq)).toBe(0);
    const ok = await post("/v1/admin/jobs/settle/run", { date: "2026-11-25" });
    expect(ok.body).toMatchObject({ job: "SETTLE", date: "2026-11-25", status: "QUEUED" });
    const [entry] = await redis.xrange(K.jobreq, "-", "+");
    expect(entry![1]).toEqual(["job", "SETTLE", "date", "2026-11-25", "requested_by", ADMIN, "requested_at", expect.any(String)]);
    expect((await post("/v1/admin/jobs/settle/run", { date: "11/25" })).body.error.code).toBe("VALIDATION");
  });

  it("jobs and alerts are read from PG; an ack records who acked", async () => {
    if (!r || !db) return;
    await db.pool.query(`INSERT INTO job_runs (job, trading_date, symbol, attempt, status, started_at) VALUES ('SETTLE', '2026-11-25', 'META', 1, 'OK', '2026-11-25T21:05:00Z')`);
    const a = await db.pool.query<{ id: string }>(`INSERT INTO alerts (severity, code, symbol, trading_date, message) VALUES ('PAGE', 'SETTLE_SLA_AT_RISK', 'META', '2026-11-25', 'late') RETURNING id::text`);
    expect((await get("/v1/admin/jobs?date=2026-11-25")).body.data).toEqual([expect.objectContaining({ job: "SETTLE", symbol: "META", status: "OK", attempt: 1 })]);
    expect((await get("/v1/admin/alerts")).body.data).toHaveLength(1);
    const ack = await post(`/v1/admin/alerts/${a.rows[0]!.id}/ack`);
    expect(ack.body).toMatchObject({ id: a.rows[0]!.id, ackedBy: ADMIN });
    expect((await get("/v1/admin/alerts?open=true")).body.data).toHaveLength(0);
    expect((await get("/v1/admin/alerts?open=false")).body.data[0]).toMatchObject({ ackedBy: ADMIN });
    expect((await post("/v1/admin/alerts/999/ack")).status).toBe(404);
  });

  it("every admin call, accepted or refused, is audit-logged with caller and payload", async () => {
    if (!r || !db) return;
    await post("/v1/admin/tx/pause", { note: "maintenance" });
    await post("/v1/admin/tx/pause", {}, token(U.bob, clock));
    await post("/v1/admin/jobs/PAUSE/run", { date: "2026-11-25" });
    const rows = (await db.pool.query("SELECT caller, route, payload, status, error_code FROM admin_audit ORDER BY id")).rows;
    expect(rows).toEqual([
      { caller: ADMIN, route: "POST /v1/admin/tx/pause", payload: { params: {}, query: {}, body: { note: "maintenance" } }, status: 200, error_code: null },
      { caller: U.bob, route: "POST /v1/admin/tx/pause", payload: expect.any(Object), status: 403, error_code: "UNAUTHORIZED" },
      { caller: ADMIN, route: "POST /v1/admin/jobs/:job/run", payload: { params: { job: "PAUSE" }, query: {}, body: { date: "2026-11-25" } }, status: 409, error_code: "NOT_RERUNNABLE" },
    ]);
  });
});
