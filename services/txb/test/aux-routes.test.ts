// MER-63: mint, merge, cancel, withdraw, redeem and dispute routes, executed on the real program.
import { AddressLookupTableAccount, Keypair, PublicKey } from "@solana/web3.js";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { K } from "../../shared/src/keys.js";
import { buildTxb } from "../src/app.js";
import { coder, PROGRAM_ID } from "../src/chain/idl.js";
import { ata, configPda, eventAuthority, TOKEN_PROGRAM_ID } from "../src/chain/pdas.js";
import { decodeTx, Env, makeEnv, post, trade } from "./helpers/env.js";
import { startTestRedis, TestRedis } from "./helpers/redis.js";
import { DATE, haveProgram, Market, T } from "./helpers/svm.js";

const USDC = 1_000_000n;

describe.skipIf(!haveProgram)("aux routes", () => {
  let r: TestRedis | null;
  let redis: Redis;
  let e: Env;
  let bob: Keypair;
  beforeAll(async () => {
    r = await startTestRedis();
  });
  afterAll(async () => {
    await e?.app.close();
    await r?.stop();
  });
  beforeEach(async () => {
    if (!r) return;
    await r.flush();
    redis = r.client();
    await e?.app.close();
    e = await makeEnv(redis);
    bob = e.svm.user("bob", 10_000n * USDC);
    e.svm.mint(bob, e.m, 200n);
    e.svm.place(bob, e.m, "ask", 64, 50n);
    e.svm.place(bob, e.m, "bid", 61, 50n);
    await sync();
  });
  const sync = (m: Market = e.m, extra: Record<string, string> = {}) => e.svm.syncRedis(redis, "META", m, extra);
  const own = (u: Keypair, extra: object = {}) => ({ owner: u.publicKey.toBase58(), marketId: e.mid, ...extra });
  const exec = (b64: string, u: Keypair) => {
    const res = e.svm.signAndSend(b64, u);
    expect(res.ok, res.logs.join("\n")).toBe(true);
  };

  /** Flips a Market account to SETTLED/VOID with an outcome, as settle_market would. */
  async function settleMarket(m: Market, outcome: "Yes" | "No" | "Void") {
    const a = e.svm.svm.getAccount(m.address)!;
    const d = coder.accounts.decode("Market", Buffer.from(a.data)) as Record<string, unknown>;
    d.status = outcome === "Void" ? { Void: {} } : { Settled: {} };
    d.outcome = { [outcome]: {} };
    const b = await (coder.accounts as unknown as { encode(n: string, v: unknown): Promise<Buffer> }).encode("Market", d);
    const data = Buffer.alloc(a.data.length);
    b.copy(data);
    e.svm.svm.setAccount(m.address, { ...a, data });
    await sync(m, { status: outcome === "Void" ? "VOID" : "SETTLED", outcome: outcome.toUpperCase() });
  }

  it("mint and merge build mint_pair / merge_pair and move exactly $1.00 a pair", async () => {
    if (!r) return;
    const alice = e.svm.user("alice", 100n * USDC);
    await sync();
    const mint = await post(e.app, "/v1/tx/mint", own(alice, { pairs: 10 }));
    expect(decodeTx(mint.body.transaction).ixs.map((i) => [i.name, String(i.data.n)])).toEqual([["mint_pair", "10"]]);
    expect(mint.body.summary).toMatchObject({ action: "MINT", maxCost: "10000000" });
    exec(mint.body.transaction, alice);
    expect(e.svm.usdc(alice)).toBe(90n * USDC);
    await sync();
    const merge = await post(e.app, "/v1/tx/merge", own(alice, { pairs: 4 }));
    expect(decodeTx(merge.body.transaction).ixs.map((i) => i.name)).toEqual(["merge_pair"]);
    exec(merge.body.transaction, alice);
    expect(e.svm.usdc(alice)).toBe(94n * USDC);
    await sync();
    expect((await post(e.app, "/v1/tx/merge", own(alice, { pairs: 7 }))).body.error).toMatchObject({ code: "POSITION_CONFLICT", details: { available: 6 } });
    // Mint follows the entry rules: paused and before mint_open are refused; merge still works when paused.
    await redis.hset(K.cfg, "paused", "1");
    expect((await post(e.app, "/v1/tx/mint", own(alice, { pairs: 1 }))).body.error.code).toBe("PAUSED");
    expect((await post(e.app, "/v1/tx/merge", own(alice, { pairs: 1 }))).status).toBe(200);
    await redis.hset(K.cfg, "paused", "0");
    e.clock.t = T.mintOpen - 60;
    expect((await post(e.app, "/v1/tx/mint", own(alice, { pairs: 1 }))).body.error.code).toBe("MARKET_NOT_OPEN");
    e.clock.t = T.mintOpen + 60; // mint opens an hour before the book (D26)
    expect((await post(e.app, "/v1/tx/mint", own(alice, { pairs: 1 }))).status).toBe(200);
  });

  it("cancel of a BUY_NO order uses the program's merge path and returns the $1.00 a pair; cancel all; unknown order → NOT_FOUND", async () => {
    if (!r) return;
    const erin = e.svm.user("erin", 100n * USDC);
    await sync();
    const b = await post(e.app, "/v1/tx/trade", trade(erin, e.mid, "BUY_NO", "LIMIT", 10, 30));
    exec(b.body.transaction, erin);
    await sync();
    expect(e.svm.usdc(erin)).toBe(90n * USDC);
    const id = e.svm.orders(e.m).find((o) => o.owner === erin.publicKey.toBase58())!.orderId.toString();
    const c = await post(e.app, "/v1/tx/cancel", own(erin, { orderId: id }));
    expect(c.body.summary).toMatchObject({ action: "CANCEL", intent: "BUY_NO", mergesPairs: 10 });
    const ix = decodeTx(c.body.transaction).ixs[0]!;
    expect(ix.name).toBe("cancel_order");
    expect(String(ix.data.order_id)).toBe(id);
    // The merge path's accounts: collateral vault and both mints, and the user's No account.
    for (const k of [e.m.vault, e.m.noMint, e.m.yesMint, ata(erin.publicKey, e.m.noMint)]) expect(ix.accounts.map(String)).toContain(k.toBase58());
    exec(c.body.transaction, erin);
    expect(e.svm.usdc(erin)).toBe(100n * USDC);
    expect(e.svm.token(ata(erin.publicKey, e.m.noMint))).toBe(0n);
    await sync();
    expect((await post(e.app, "/v1/tx/cancel", own(erin, { orderId: id }))).body.error.code).toBe("NOT_FOUND");
    const all = await post(e.app, "/v1/tx/cancel", own(bob, { all: true }));
    expect(decodeTx(all.body.transaction).ixs.map((i) => i.name)).toEqual(["cancel_all"]);
    exec(all.body.transaction, bob);
    expect(e.svm.orders(e.m)).toEqual([]);
  });

  it("withdraw builds only when the ledger holds funds; it is bundled into cancel when it does", async () => {
    if (!r) return;
    const alice = e.svm.user("alice", 100n * USDC);
    await sync();
    expect((await post(e.app, "/v1/tx/withdraw", own(bob))).body.error.code).toBe("NOT_FOUND");
    exec((await post(e.app, "/v1/tx/trade", trade(alice, e.mid, "BUY_YES", "MARKET", 10, 64))).body.transaction, alice);
    await sync();
    const w = await post(e.app, "/v1/tx/withdraw", own(bob));
    expect(w.body).toMatchObject({ summary: { action: "WITHDRAW", usdc: "6400000" }, warnings: [] });
    expect(decodeTx(w.body.transaction).ixs.map((i) => i.name)).toEqual(["withdraw"]);
    const c = await post(e.app, "/v1/tx/cancel", own(bob, { all: true }));
    expect(decodeTx(c.body.transaction).ixs.map((i) => i.name)).toEqual(["cancel_all", "withdraw"]);
    expect(c.body.warnings).toEqual(["LEDGER_WITHDRAW_BUNDLED"]);
    const before = e.svm.usdc(bob);
    exec(c.body.transaction, bob);
    // $6.40 of proceeds plus the $30.50 the 61 bid had locked.
    expect(e.svm.usdc(bob) - before).toBe(6_400_000n + 30_500_000n);
  });

  it("RED-09 redeem batches many settled markets, splits under 1,232 bytes, and pays every market", async () => {
    if (!r) return;
    const alice = e.svm.user("alice", 1_000n * USDC);
    const markets = [e.m, ...[66000n, 70000n, 72000n, 74000n].map((s) => e.svm.createMarket("META", s))];
    for (const m of markets) e.svm.mint(alice, m, 10n);
    for (const m of markets) await settleMarket(m, "Yes");
    const before = e.svm.usdc(alice);
    const res = await post(e.app, "/v1/tx/redeem", { owner: alice.publicKey.toBase58(), marketIds: markets.map((m) => m.address.toBase58()) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.summary).toMatchObject({ action: "REDEEM", markets: 5, payout: "50000000" });
    const txs = res.body.transactions as string[];
    expect(txs.length).toBeGreaterThan(1);
    expect(res.body.warnings).toContain("SPLIT_INTO_MULTIPLE_TXS");
    expect(res.body.transaction).toBe(txs[0]);
    const redeemed: string[] = [];
    for (const t of txs) {
      expect(Buffer.from(t, "base64").length).toBeLessThanOrEqual(1232);
      for (const ix of decodeTx(t).ixs) if (ix.name === "redeem") redeemed.push(ix.accounts[2]!.toBase58());
      exec(t, alice);
    }
    expect(redeemed.sort()).toEqual(markets.map((m) => m.address.toBase58()).sort());
    expect(e.svm.usdc(alice) - before).toBe(50n * USDC);
    for (const m of markets) expect(e.svm.token(ata(alice.publicKey, m.yesMint))).toBe(0n);

    // With the ticker-day ALT the same five markets fit in one transaction.
    const addrs = [configPda(), eventAuthority(), PROGRAM_ID, TOKEN_PROGRAM_ID, e.svm.usdcMint, ...markets.flatMap((m) => [m.address, m.vault, m.yesMint, m.noMint])];
    const alt = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: addrs } });
    const withAlt = await buildTxb({ redis, blockhash: { get: () => e.svm.blockhash() }, alts: { get: () => alt }, usdcMint: e.svm.usdcMint, bondVault: e.svm.bondVault, now: () => e.clock.t * 1000 });
    for (const m of markets) await e.svm.syncRedis(redis, "META", m, { status: "SETTLED", outcome: "YES" });
    // Positions are back to zero on chain; give alice tokens again in Redis only (build-only check).
    for (const m of markets) await redis.hset(K.pos(alice.publicKey.toBase58()), m.address.toBase58(), JSON.stringify({ yes: 10, no: 10, ledger_usdc: "0", ledger_yes: 0, pending_no: 0 }));
    const one = await post(withAlt, "/v1/tx/redeem", { owner: alice.publicKey.toBase58(), marketIds: markets.map((m) => m.address.toBase58()) });
    expect(one.body.transactions).toHaveLength(1);
    expect(one.body.warnings).not.toContain("SPLIT_INTO_MULTIPLE_TXS");
    await withAlt.close();
  });

  it("redeem refuses unsettled markets, bundles a withdraw, and void pays $0.50 a token", async () => {
    if (!r) return;
    const alice = e.svm.user("alice", 1_000n * USDC);
    await sync();
    expect((await post(e.app, "/v1/tx/redeem", { owner: alice.publicKey.toBase58(), marketIds: [e.mid] })).body.error.code).toBe("NOT_SETTLED");
    e.svm.mint(alice, e.m, 4n);
    exec((await post(e.app, "/v1/tx/trade", trade(alice, e.mid, "BUY_YES", "MARKET", 0 + 2, 64))).body.transaction, alice);
    await settleMarket(e.m, "Void");
    // bob's ask was hit, so his ledger holds USDC; his redeem withdraws it first.
    const res = await post(e.app, "/v1/tx/redeem", { owner: bob.publicKey.toBase58(), marketIds: [e.mid] });
    expect(res.body.warnings).toContain("LEDGER_WITHDRAW_BUNDLED");
    expect(decodeTx(res.body.transaction).ixs.map((i) => i.name)).toEqual(["withdraw", "redeem"]);
    const a = await post(e.app, "/v1/tx/redeem", { owner: alice.publicKey.toBase58(), marketIds: [e.mid] });
    expect(a.body.summary.payout).toBe(String((6n + 4n) * 500_000n));
    const before = e.svm.usdc(alice);
    exec(a.body.transaction, alice);
    expect(e.svm.usdc(alice) - before).toBe(5n * USDC);
  });

  it("PSE-06 while paused, trades are refused but cancel, merge, withdraw and redeem still build", async () => {
    if (!r) return;
    const alice = e.svm.user("alice", 100n * USDC);
    await sync();
    exec((await post(e.app, "/v1/tx/trade", trade(alice, e.mid, "BUY_YES", "MARKET", 10, 64))).body.transaction, alice);
    await sync();
    await redis.hset(K.cfg, "paused", "1");
    expect((await post(e.app, "/v1/tx/trade", trade(alice, e.mid, "SELL_YES", "LIMIT", 1, 70))).body.error.code).toBe("PAUSED");
    expect((await post(e.app, "/v1/tx/cancel", own(bob, { all: true }))).status).toBe(200);
    expect((await post(e.app, "/v1/tx/merge", own(bob, { pairs: 1 }))).status).toBe(200);
    expect((await post(e.app, "/v1/tx/withdraw", own(bob))).status).toBe(200);
    await settleMarket(e.m, "Yes");
    expect((await post(e.app, "/v1/tx/redeem", { owner: alice.publicKey.toBase58(), marketIds: [e.mid] })).status).toBe(200);
  });

  it("dispute builds raise_dispute with the evidence hash only while the close is PROVISIONAL and the window is open", async () => {
    if (!r) return;
    const eve = e.svm.user("eve", 500n * USDC);
    const body = { owner: eve.publicKey.toBase58(), symbol: "META", date: "2026-11-25", evidenceUrl: "https://example.com/nocp.pdf" };
    expect((await post(e.app, "/v1/tx/dispute", body)).body.error.code).toBe("DISPUTE_WINDOW_CLOSED");
    await redis.hset(K.tday("META", DATE), { status: "PROVISIONAL", recorded_at: String(T.close + 300), final_at_est: String(T.close + 1500) });
    e.clock.t = T.close + 600;
    const ok = await post(e.app, "/v1/tx/dispute", body);
    expect(ok.status).toBe(200);
    const ix = decodeTx(ok.body.transaction).ixs[0]!;
    expect(ix.name).toBe("raise_dispute");
    expect(Buffer.from(ix.data.evidence_hash as number[]).toString("hex")).toBe(ok.body.summary.evidenceHash);
    expect(ix.accounts.map(String)).toContain(e.svm.bondVault.toBase58());
    expect(ok.body.summary).toMatchObject({ bond: "100000000" });
    expect(ok.body.summary.copy).toContain("$100.00 bond");
    e.clock.t = T.close + 1500;
    expect((await post(e.app, "/v1/tx/dispute", body)).body.error.code).toBe("DISPUTE_WINDOW_CLOSED");
    expect((await post(e.app, "/v1/tx/dispute", { ...body, evidenceUrl: "javascript:alert(1)" })).body.error.code).toBe("VALIDATION");
    expect(new PublicKey(ix.accounts[0]!).equals(eve.publicKey)).toBe(true);
  });
});
