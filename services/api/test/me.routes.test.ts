// MER-61: SIWS sign-in and portfolio routes, scoped to the JWT subject.
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { K } from "../../shared/src/keys.js";
import { auth, checkUnits, Clock, makeApp, token, wallet } from "./helpers/app.js";
import { M680, replay, T, U } from "./helpers/day.js";
import { startTestDb, TestDb } from "./helpers/pg.js";
import { startTestRedis, TestRedis } from "./helpers/redis.js";

describe("me routes", () => {
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
    app = await makeApp(redis, db?.pool ?? null, clock);
  });
  const call = async (method: "GET" | "POST" | "PUT", url: string, o: { token?: string; body?: unknown } = {}) => {
    const res = await app.inject({ method, url, headers: o.token ? auth(o.token) : {}, payload: o.body as object | undefined });
    return { status: res.statusCode, body: res.json() };
  };

  async function signIn(w = wallet()) {
    const n = await call("POST", "/v1/auth/siws/nonce", { body: { owner: w.pubkey } });
    expect(n.status).toBe(200);
    const signature = w.signMessage(n.body.message);
    return { w, n: n.body, signature, verify: () => call("POST", "/v1/auth/siws/verify", { body: { owner: w.pubkey, message: n.body.message, signature } }) };
  }

  it("SIWS issues a short-lived JWT for a valid signature; a bad signature or a changed message is rejected", async () => {
    if (!r) return;
    const s = await signIn();
    expect(s.n.message).toContain(`Nonce: ${s.n.nonce}`);
    expect(s.n.message).toContain(s.w.pubkey);
    const v = await s.verify();
    expect(v.status).toBe(200);
    expect(Date.parse(v.body.expiresAt) / 1000).toBe(clock.t + 900);
    expect((await call("GET", "/v1/me/positions", { token: v.body.token })).status).toBe(200);

    const other = wallet();
    const bad = await signIn();
    const forged = await call("POST", "/v1/auth/siws/verify", { body: { owner: bad.w.pubkey, message: bad.n.message, signature: other.signMessage(bad.n.message) } });
    expect(forged).toMatchObject({ status: 401, body: { error: { code: "UNAUTHORIZED", message: "Bad signature" } } });
    const changed = await signIn();
    const msg = changed.n.message.replace("Sign in to Meridian", "Sign in to Evil");
    const res = await call("POST", "/v1/auth/siws/verify", { body: { owner: changed.w.pubkey, message: msg, signature: changed.w.signMessage(msg) } });
    expect(res.status).toBe(401);
    expect((await call("POST", "/v1/auth/siws/nonce", { body: { owner: "not-a-key" } })).body.error.code).toBe("VALIDATION");
  });

  it("API-07 a SIWS nonce is single-use: replaying the same signature is rejected", async () => {
    if (!r) return;
    const s = await signIn();
    expect((await s.verify()).status).toBe(200);
    const again = await s.verify();
    expect(again).toMatchObject({ status: 401, body: { error: { code: "UNAUTHORIZED" } } });
    // Nonces also expire.
    const late = await signIn();
    await redis.del(K.siws(late.n.nonce)); // as the 5 min TTL would
    expect((await late.verify()).status).toBe(401);
  });

  it("API-06 /v1/me/* needs a token, rejects an expired one, and only ever shows the subject's data", async () => {
    if (!r) return;
    await replay(redis, "carol sell no 5");
    expect((await call("GET", "/v1/me/positions")).status).toBe(401);
    expect((await call("GET", "/v1/me/positions", { token: token(U.bob, clock, { ttl: -1 }) })).body.error).toMatchObject({ code: "UNAUTHORIZED", details: { reason: "EXPIRED" } });
    expect((await call("GET", "/v1/me/positions", { token: "abc.def.ghi" })).status).toBe(401);
    const bobs = await call("GET", `/v1/me/positions?owner=${U.alice}`, { token: token(U.bob, clock) });
    const alices = await call("GET", "/v1/me/positions", { token: token(U.alice, clock) });
    expect(bobs.status).toBe(200);
    expect(bobs.body).not.toEqual(alices.body);
    const bobPos = JSON.parse((await redis.hget(K.pos(U.bob), M680))!);
    expect(bobs.body.data).toEqual([expect.objectContaining({ marketId: M680, yesQty: bobPos.yes, noQty: bobPos.no })]);
    const orders = await call("GET", `/v1/me/orders?owner=${U.alice}`, { token: token(U.dave, clock) });
    expect(orders.body.data.every((o: { marketId: string }) => o.marketId === M680)).toBe(true);
  });

  it("POS-05 a resting Buy No limit shows as one BOTH_PENDING position, and its order reads in No terms", async () => {
    if (!r) return;
    await replay(redis, "dave buy no limit 10 @ 65");
    const p = await call("GET", "/v1/me/positions", { token: token(U.dave, clock) });
    expect(p.body.data).toEqual([expect.objectContaining({ marketId: M680, side: "BOTH_PENDING", qty: 10, yesQty: 10, noQty: 10, avgEntryCents: 100 })]);
    const o = await call("GET", "/v1/me/orders", { token: token(U.dave, clock) });
    expect(o.body.data).toEqual([expect.objectContaining({ intent: "BUY_NO", bookSide: "ASK", yesPriceCents: 65, priceCents: 35, remaining: 10, status: "OPEN" })]);
    // carol's Buy No market: No at 100 − 61 = 39 plus the 1% fee.
    const c = await call("GET", "/v1/me/positions", { token: token(U.carol, clock) });
    expect(c.body.data[0]).toMatchObject({ side: "NO", qty: 10, markCents: 37.5 });
    expect(c.body.data[0].avgEntryCents).toBeCloseTo(39.61, 2);
    expect(checkUnits(c.body)).toEqual([]);
  });

  it("RED-10 claimable lists unwithdrawn ledger proceeds and redeemable winners, matching the chain-derived positions", async () => {
    if (!r) return;
    await replay(redis, "close books");
    clock.t = T.close + 3 * 3600;
    // bob: maker proceeds still in his ledger (USDC from asks, Yes from bids) and 10 winning Yes.
    const bob = await call("GET", "/v1/me/claimable", { token: token(U.bob, clock) });
    const bp = JSON.parse((await redis.hget(K.pos(U.bob), M680))!);
    expect(bob.body.data).toEqual([expect.objectContaining({ marketId: M680, status: "SETTLED", ledger: { freeUsdc: bp.ledger_usdc, freeYes: bp.ledger_yes }, redeemable: String(bp.yes * 1_000_000) })]);
    expect(bob.body.totals).toEqual({ ledgerUsdc: "24400000", redeemable: "10000000" });
    // alice still holds 70 winning Yes (minted 100, sold 20, merged 10) before she redeems.
    expect((await call("GET", "/v1/me/claimable", { token: token(U.alice, clock) })).body.totals).toEqual({ ledgerUsdc: "0", redeemable: "70000000" });
    // frank's pruned Buy No left $2.00 in his ledger.
    expect((await call("GET", "/v1/me/claimable", { token: token(U.frank, clock) })).body.totals.ledgerUsdc).toBe("2000000");
    const pos = await call("GET", "/v1/me/positions?status=SETTLED", { token: token(U.bob, clock) });
    expect(pos.body.data[0]).toMatchObject({ status: "SETTLED", outcome: "YES", markCents: 100, redeemable: "10000000" });
    expect((await call("GET", "/v1/me/positions", { token: token(U.bob, clock) })).body.data).toEqual([]);
    // After her redeem there is nothing left to claim.
    await replay(redis);
    expect((await call("GET", "/v1/me/claimable", { token: token(U.alice, clock) })).body.totals).toEqual({ ledgerUsdc: "0", redeemable: "0" });
  });

  it("IDX-02 history reports the user's intent (BUY_NO at the No price), not the raw book side", async () => {
    if (!r || !db) return;
    const t = token(U.carol, clock);
    await db.pool.query(`INSERT INTO ticker_days (pda, symbol, trading_date, close_time, status) VALUES ('td', 'META', '2026-11-25', '2026-11-25T21:00:00Z', 'OPEN')`);
    await db.pool.query(`INSERT INTO markets (pda, ticker_day_pda, symbol, trading_date, strike_cents, yes_mint, no_mint, vault, status, created_by, created_slot)
      VALUES ($1, 'td', 'META', '2026-11-25', 68000, 'y', 'n', 'v', 'TRADING', 'AUTO', 1)`, [M680]);
    await db.pool.query(`INSERT INTO fills VALUES ('s1', 2, $1, 5, 2, $2, $3, 'ASK', 61, 10, 6100, 'BUY_YES', 'BUY_NO', 1, '2026-11-25T15:46:00Z'),
      ('s2', 1, $1, 9, 3, $4, $3, 'BID', 65, 5, 3250, 'BUY_NO', 'SELL_NO', 2, '2026-11-25T15:47:00Z'),
      ('s3', 1, $1, 10, 4, $3, $5, 'BID', 64, 3, 0, 'SELL_YES', 'BUY_YES', 3, '2026-11-25T15:48:00Z')`, [M680, U.bob, U.carol, U.dave, U.erin]);
    const h = await call("GET", "/v1/me/history", { token: t });
    expect(h.body.data).toEqual([
      { time: "2026-11-25T15:48:00Z", marketId: M680, intent: "SELL_YES", qty: 3, priceCents: 64, fee: "0", usdc: null, signature: "s3" },
      { time: "2026-11-25T15:47:00Z", marketId: M680, intent: "SELL_NO", qty: 5, priceCents: 35, fee: "3250", usdc: null, signature: "s2" },
      { time: "2026-11-25T15:46:00Z", marketId: M680, intent: "BUY_NO", qty: 10, priceCents: 39, fee: "6100", usdc: null, signature: "s1" },
    ]);
    const page = await call("GET", "/v1/me/history?limit=1&before=2026-11-25T15:48:00Z", { token: t });
    expect(page.body.data.map((x: { signature: string }) => x.signature)).toEqual(["s2"]);
    // Order history (ALL) comes from PG.
    await db.pool.query(`INSERT INTO orders VALUES ($1, 7, $2, 'BID', 40, 10, 0, 'GTC', 'NONE', 'SELL_NO', 'CANCELLED', 'USER', 'p', '2026-11-25T15:40:00Z', '2026-11-25T15:41:00Z')`, [M680, U.carol]);
    const all = await call("GET", "/v1/me/orders?status=ALL", { token: t });
    expect(all.body.data).toEqual([expect.objectContaining({ orderId: "7", intent: "SELL_NO", priceCents: 60, yesPriceCents: 40, status: "CANCELLED" })]);
  });

  it("prefs are validated and upserted for the subject only (user_prefs is the only table written)", async () => {
    if (!r || !db) return;
    const t = token(U.alice, clock);
    expect((await call("PUT", "/v1/me/prefs", { token: t, body: { defaultView: "SIDEWAYS" } })).body.error.code).toBe("VALIDATION");
    expect((await call("PUT", "/v1/me/prefs", { token: t, body: { slippageCents: 99 } })).body.error.code).toBe("VALIDATION");
    expect((await call("PUT", "/v1/me/prefs", { token: t, body: { owner: U.bob } })).body.error.code).toBe("VALIDATION");
    expect((await call("PUT", "/v1/me/prefs", { token: t, body: { defaultView: "NO", slippageCents: 3 } })).body).toEqual({ defaultView: "NO", slippageCents: 3 });
    expect((await call("PUT", "/v1/me/prefs", { token: t, body: { slippageCents: 5 } })).body).toEqual({ defaultView: "NO", slippageCents: 5 });
    expect((await call("GET", "/v1/me/prefs", { token: token(U.bob, clock) })).body).toEqual({ defaultView: "YES", slippageCents: 2 });
    const rows = await db.pool.query("SELECT owner FROM user_prefs");
    expect(rows.rows).toEqual([{ owner: U.alice }]);
  });
});
