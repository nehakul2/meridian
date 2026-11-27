// MER-62: intent → instruction mapping, guards and summary, executed against the real program.
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { Keypair } from "@solana/web3.js";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { K } from "../../shared/src/keys.js";
import { ixSellNo } from "../src/chain/ixs.js";
import { ata, ledgerPda } from "../src/chain/pdas.js";
import { decodeTx, Env, isCompute, makeEnv, post, str, trade } from "./helpers/env.js";
import { startTestRedis, TestRedis } from "./helpers/redis.js";
import { haveProgram, T } from "./helpers/svm.js";

const USDC = 1_000_000n;

describe.skipIf(!haveProgram)("intent map", () => {
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
  // A fresh chain per test: bob makes a market of 50 @ 61 / 50 @ 64.
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
  const sync = () => e.svm.syncRedis(redis, "META", e.m);
  const yesOf = (u: Keypair) => e.svm.token(ata(u.publicKey, e.m.yesMint));
  const noOf = (u: Keypair) => e.svm.token(ata(u.publicKey, e.m.noMint));

  /** Builds, checks the response shape, signs as the wallet and executes on LiteSVM. */
  async function run(u: Keypair, intent: string, type: string, qty: number, price: number, expect200 = true) {
    const res = await post(e.app, "/v1/tx/trade", trade(u, e.mid, intent, type, qty, price));
    if (expect200) expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (res.status !== 200) return { res, d: null, exec: null };
    const d = decodeTx(res.body.transaction);
    const exec = e.svm.signAndSend(res.body.transaction, u);
    expect(exec.ok, exec.logs.join("\n")).toBe(true);
    await sync();
    return { res, d, exec };
  }

  it("API-01 every intent × order type compiles to the spec 7.4 instruction and executes on the real program", async () => {
    if (!r) return;
    const alice = e.svm.user("alice", 1_000n * USDC);
    const carol = e.svm.user("carol", 1_000n * USDC);
    const dave = e.svm.user("dave", 1_000n * USDC);
    const erin = e.svm.user("erin", 1_000n * USDC);
    await sync();

    // BUY_YES MARKET → place_order(BID, 64, IOC), bob's ledger passed as a maker.
    let x = await run(alice, "BUY_YES", "MARKET", 10, 64);
    expect(x.d!.ixs.at(-1)).toMatchObject({ name: "place_order", data: { side: { Bid: {} }, price: 64, tif: { Ioc: {} } } });
    expect(str(x.d!.ixs.at(-1)!.data.qty)).toBe("10");
    expect(x.d!.ixs.at(-1)!.accounts.map(String)).toContain(ledgerPda(e.m.address, bob.publicKey).toBase58());
    expect(yesOf(alice)).toBe(10n);
    // BUY_YES LIMIT → place_order(BID, 60, GTC), rests.
    x = await run(alice, "BUY_YES", "LIMIT", 5, 60);
    expect(x.d!.ixs.at(-1)).toMatchObject({ name: "place_order", data: { side: { Bid: {} }, price: 60, tif: { Gtc: {} } } });
    expect(e.svm.orders(e.m).some((o) => o.owner === alice.publicKey.toBase58() && o.price === 60 && o.side === "BID")).toBe(true);
    // SELL_YES MARKET → place_order(ASK, 61, IOC) into bob's bid; SELL_YES LIMIT → ASK GTC.
    await run(carol, "BUY_YES", "MARKET", 10, 64);
    x = await run(carol, "SELL_YES", "MARKET", 4, 61);
    expect(x.d!.ixs.at(-1)).toMatchObject({ name: "place_order", data: { side: { Ask: {} }, price: 61, tif: { Ioc: {} } } });
    expect(yesOf(carol)).toBe(6n);
    x = await run(carol, "SELL_YES", "LIMIT", 3, 70);
    expect(x.d!.ixs.at(-1)).toMatchObject({ name: "place_order", data: { side: { Ask: {} }, price: 70, tif: { Gtc: {} } } });
    // BUY_NO MARKET at No 39 → buy_no_market(qty, min_yes = 61).
    x = await run(dave, "BUY_NO", "MARKET", 10, 39);
    expect(x.d!.ixs.at(-1)).toMatchObject({ name: "buy_no_market", data: { min_yes_price: 61 } });
    expect(noOf(dave)).toBe(10n);
    // BUY_NO LIMIT at No 30 → buy_no_limit(qty, yes = 70), rests as a BUY_NO ask.
    x = await run(erin, "BUY_NO", "LIMIT", 10, 30);
    expect(x.d!.ixs.at(-1)).toMatchObject({ name: "buy_no_limit", data: { yes_price: 70 } });
    expect(e.svm.orders(e.m).find((o) => o.owner === erin.publicKey.toBase58())).toMatchObject({ side: "ASK", price: 70, tag: 1 });
    // SELL_NO MARKET at No 36 → sell_no(qty, max_yes = 64).
    x = await run(dave, "SELL_NO", "MARKET", 4, 36);
    expect(x.d!.ixs.at(-1)).toMatchObject({ name: "sell_no", data: { max_yes_price: 64 } });
    expect(noOf(dave)).toBe(6n);
    // SELL_NO LIMIT at No 60 → place_order(BID, 40, GTC).
    x = await run(dave, "SELL_NO", "LIMIT", 6, 60);
    expect(x.d!.ixs.at(-1)).toMatchObject({ name: "place_order", data: { side: { Bid: {} }, price: 40, tif: { Gtc: {} } } });
    expect(x.res.body.summary).toMatchObject({ intent: "SELL_NO", worstPriceCents: 60, yesPriceCents: 40, instruction: "place_order" });
  });

  it("API-02 the transaction is unsigned, paid by the owner, with a recent blockhash and lastValidBlockHeight", async () => {
    if (!r) return;
    const alice = e.svm.user("alice", 1_000n * USDC);
    await sync();
    const res = await post(e.app, "/v1/tx/trade", trade(alice, e.mid, "BUY_YES", "LIMIT", 5, 60));
    const { tx } = decodeTx(res.body.transaction);
    expect(tx.signatures).toHaveLength(1);
    expect(tx.signatures[0]!.every((b) => b === 0)).toBe(true);
    expect(tx.message.staticAccountKeys[0]!.equals(alice.publicKey)).toBe(true);
    expect(tx.message.recentBlockhash).toBe(e.svm.blockhash().blockhash);
    expect(tx.message.version).toBe(0);
    expect(res.body.lastValidBlockHeight).toBe(1000);
    expect(isCompute(tx, 0)).toBe(true);
  });

  it("API-03 a MARKET order without a worst price is a 400 VALIDATION", async () => {
    if (!r) return;
    const alice = e.svm.user("alice", 1_000n * USDC);
    const res = await post(e.app, "/v1/tx/trade", trade(alice, e.mid, "BUY_YES", "MARKET", 5));
    expect(res).toMatchObject({ status: 400, body: { error: { code: "VALIDATION", details: { field: "priceCents" } } } });
  });

  it("API-04 / TRD-16 summary copy says 'at or above' for Yes and 'below' for No; numbers are exact", async () => {
    if (!r) return;
    const alice = e.svm.user("alice", 1_000n * USDC);
    await sync();
    const y = await post(e.app, "/v1/tx/trade", trade(alice, e.mid, "BUY_YES", "LIMIT", 100, 64));
    expect(y.body.summary).toMatchObject({
      intent: "BUY_YES", qty: 100, worstPriceCents: 64, maxCost: "64000000", payoutIfWin: "100000000",
      copy: "You pay up to $64.00. You win $100.00 if META closes at or above $680.00.",
    });
    // TRD-16: the Buy No quote at No 39 (= 100 − best Yes bid 61) maps to min_yes 61.
    const n = await post(e.app, "/v1/tx/trade", trade(alice, e.mid, "BUY_NO", "MARKET", 10, 39));
    expect(n.body.summary).toMatchObject({ intent: "BUY_NO", worstPriceCents: 39, yesPriceCents: 61, maxCost: "3900000", copy: "You pay up to $3.90. You win $10.00 if META closes below $680.00." });
    const s = await post(e.app, "/v1/tx/trade", trade(bob, e.mid, "SELL_YES", "LIMIT", 10, 70));
    expect(s.body.summary).toMatchObject({ maxCost: "0", minProceeds: "7000000", copy: "You receive at least $7.00. You give up $10.00 if META closes at or above $680.00." });
    // With a 1% taker fee the fee is in the bound.
    await redis.hset(K.cfg, "fee_bps", "100");
    const f = await post(e.app, "/v1/tx/trade", trade(alice, e.mid, "BUY_YES", "LIMIT", 100, 64));
    expect(f.body.summary).toMatchObject({ fee: "640000", maxCost: "64640000", copy: "You pay up to $64.64. You win $100.00 if META closes at or above $680.00." });
  });

  it("POS-01 / POS-02 / POS-03 / SELL_NO guard: 409 POSITION_CONFLICT with the required action, and no tx", async () => {
    if (!r) return;
    const alice = e.svm.user("alice", 1_000n * USDC);
    const dave = e.svm.user("dave", 1_000n * USDC);
    await sync();
    await run(alice, "BUY_YES", "MARKET", 10, 64);
    await run(dave, "BUY_NO", "MARKET", 10, 39);
    const p1 = await post(e.app, "/v1/tx/trade", trade(dave, e.mid, "BUY_YES", "LIMIT", 5, 60));
    expect(p1).toMatchObject({ status: 409, body: { error: { code: "POSITION_CONFLICT", details: { requiredAction: "SELL_NO", no: 10 } } } });
    expect(p1.body.transaction).toBeUndefined();
    const p2 = await post(e.app, "/v1/tx/trade", trade(alice, e.mid, "BUY_NO", "LIMIT", 5, 30));
    expect(p2.body.error).toMatchObject({ code: "POSITION_CONFLICT", details: { requiredAction: "SELL_YES" } });
    const p3 = await post(e.app, "/v1/tx/trade", trade(alice, e.mid, "SELL_YES", "LIMIT", 11, 70));
    expect(p3.body.error).toMatchObject({ code: "POSITION_CONFLICT", details: { available: 10 } });
    const p4 = await post(e.app, "/v1/tx/trade", trade(dave, e.mid, "SELL_NO", "MARKET", 11, 36));
    expect(p4.body.error).toMatchObject({ code: "POSITION_CONFLICT", details: { available: 10 } });
  });

  it("TRD-12 Sell No above the No balance is also refused on-chain (a tx built around the guard fails, nothing bought)", async () => {
    if (!r) return;
    const alice = e.svm.user("alice", 1_000n * USDC);
    await sync();
    await run(alice, "BUY_NO", "MARKET", 5, 39);
    const before = e.svm.usdc(alice);
    const tx = (await post(e.app, "/v1/tx/trade", trade(alice, e.mid, "SELL_NO", "MARKET", 5, 36))).body.transaction as string;
    // Swap the qty to 10 in the program instruction (the API would refuse it).
    const { VersionedTransaction, TransactionMessage } = await import("@solana/web3.js");
    const v = VersionedTransaction.deserialize(Buffer.from(tx, "base64"));
    const msg = TransactionMessage.decompile(v.message);
    msg.instructions[msg.instructions.length - 1] = ixSellNo(alice.publicKey, e.m, e.svm.usdcMint, 10n, 64, [bob.publicKey]) as TransactionInstruction;
    const bad = new VersionedTransaction(msg.compileToV0Message());
    const res = e.svm.signAndSend(Buffer.from(bad.serialize()).toString("base64"), alice);
    expect(res.ok).toBe(false);
    expect(noOf(alice)).toBe(5n);
    expect(e.svm.usdc(alice)).toBe(before);
  });

  it("POS-05 a resting Buy No limit (BOTH_PENDING) still blocks Buy Yes (cancel first) but allows another Buy No", async () => {
    if (!r) return;
    const erin = e.svm.user("erin", 1_000n * USDC);
    await sync();
    await run(erin, "BUY_NO", "LIMIT", 10, 30);
    const p = JSON.parse((await redis.hget(K.pos(erin.publicKey.toBase58()), e.mid))!);
    expect(p).toMatchObject({ yes: 10, no: 10, pending_no: 10 });
    const y = await post(e.app, "/v1/tx/trade", trade(erin, e.mid, "BUY_YES", "LIMIT", 1, 50));
    expect(y.body.error).toMatchObject({ code: "POSITION_CONFLICT", details: { requiredAction: "CANCEL_BUY_NO" } });
    await run(erin, "BUY_NO", "MARKET", 5, 39);
    expect(noOf(erin)).toBe(15n);
  });

  it("POS-06 guards read confirmed balances: a sale not yet in Redis still blocks, the retry after confirmation builds", async () => {
    if (!r) return;
    const dave = e.svm.user("dave", 1_000n * USDC);
    await sync();
    await run(dave, "BUY_NO", "MARKET", 10, 39);
    // dave sells all his No; the chain has it, the Indexer has not projected it yet.
    const sell = await post(e.app, "/v1/tx/trade", trade(dave, e.mid, "SELL_NO", "MARKET", 10, 36));
    expect(e.svm.signAndSend(sell.body.transaction, dave).ok).toBe(true);
    expect(noOf(dave)).toBe(0n);
    expect((await post(e.app, "/v1/tx/trade", trade(dave, e.mid, "BUY_YES", "LIMIT", 5, 60))).status).toBe(409);
    await sync(); // confirmed → Redis
    expect((await post(e.app, "/v1/tx/trade", trade(dave, e.mid, "BUY_YES", "LIMIT", 5, 60))).status).toBe(200);
  });

  it("API-05 / HLT-04 / PSE-06 state errors come before building: NOT_FOUND, MARKET_HALTED, MARKET_NOT_OPEN, PAUSED, INSUFFICIENT_BALANCE, NO_LIQUIDITY, PARTIAL_FILL_LIKELY", async () => {
    if (!r) return;
    const alice = e.svm.user("alice", 1_000n * USDC);
    await sync();
    const code = async (b: object) => (await post(e.app, "/v1/tx/trade", b)).body.error?.code;
    expect(await code(trade(alice, "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", "BUY_YES", "LIMIT", 1, 50))).toBe("NOT_FOUND");
    expect(await code(trade(alice, e.mid, "BUY_YES", "MARKET", 5, 55))).toBe("NO_LIQUIDITY");
    const partial = await post(e.app, "/v1/tx/trade", trade(alice, e.mid, "BUY_YES", "MARKET", 80, 64));
    expect(partial.body.warnings).toContain("PARTIAL_FILL_LIKELY");
    await redis.set(K.bal(alice.publicKey.toBase58()), "1000000");
    expect(await code(trade(alice, e.mid, "BUY_YES", "LIMIT", 10, 60))).toBe("INSUFFICIENT_BALANCE");
    await redis.del(K.bal(alice.publicKey.toBase58()));
    await redis.hset(K.cfg, "paused", "1");
    expect(await code(trade(alice, e.mid, "BUY_YES", "LIMIT", 1, 50))).toBe("PAUSED");
    await redis.hset(K.cfg, "paused", "0");
    e.clock.t = T.mintOpen + 60;
    expect(await code(trade(alice, e.mid, "BUY_YES", "LIMIT", 1, 50))).toBe("MARKET_NOT_OPEN");
    e.clock.t = T.close + 10; // 16:00:10
    const h = await post(e.app, "/v1/tx/trade", trade(alice, e.mid, "BUY_YES", "LIMIT", 1, 50));
    expect(h).toMatchObject({ status: 409, body: { error: { code: "MARKET_HALTED", message: "Trading closed at 2026-11-25T21:00:00.000Z" } } });
    await redis.hset(K.mkt(e.mid), "status", "SETTLED");
    e.clock.t = T.open + 60;
    expect(await code(trade(alice, e.mid, "BUY_YES", "LIMIT", 1, 50))).toBe("MARKET_HALTED");
  });

  it("API-14 500 contracts build; 501 is 422 ORDER_TOO_LARGE for every intent, with no tx", async () => {
    if (!r) return;
    const alice = e.svm.user("alice", 1_000n * USDC);
    await sync();
    expect((await post(e.app, "/v1/tx/trade", trade(alice, e.mid, "BUY_YES", "LIMIT", 500, 10))).status).toBe(200);
    for (const intent of ["BUY_YES", "SELL_YES", "BUY_NO", "SELL_NO"]) {
      const res = await post(e.app, "/v1/tx/trade", trade(alice, e.mid, intent, "LIMIT", 501, 50));
      expect(res).toMatchObject({ status: 422, body: { error: { code: "ORDER_TOO_LARGE", details: { maxQty: 500 } } } });
      expect(res.body.transaction).toBeUndefined();
    }
    // The cap is read from md:cfg (max_qty_per_trade).
    await redis.hset(K.cfg, "max_qty_per_trade", "100");
    expect((await post(e.app, "/v1/tx/trade", trade(alice, e.mid, "BUY_YES", "LIMIT", 101, 10))).status).toBe(422);
  });

  it("TRD-14 Sell No limit rests a Yes bid; after a maker fills it, the next tx withdraws and merges (+$6.00 net)", async () => {
    if (!r) return;
    const alice = e.svm.user("alice", 1_000n * USDC);
    await sync();
    await run(alice, "BUY_NO", "MARKET", 10, 39);
    const start = e.svm.usdc(alice);
    const x = await run(alice, "SELL_NO", "LIMIT", 10, 60);
    expect(x.d!.ixs.at(-1)).toMatchObject({ name: "place_order", data: { side: { Bid: {} }, price: 40, tif: { Gtc: {} } } });
    // bob sells 10 Yes @ 40 into alice's bid; the Yes lands in alice's ledger.
    await run(bob, "SELL_YES", "MARKET", 10, 40);
    expect(e.svm.ledger(e.m, alice.publicKey)).toMatchObject({ freeYes: 10n });
    const w = await post(e.app, "/v1/tx/withdraw", { owner: alice.publicKey.toBase58(), marketId: e.mid });
    expect(decodeTx(w.body.transaction).ixs.map((i) => i.name)).toEqual(["withdraw", "merge_pair"]);
    expect(w.body.warnings).toEqual(["MERGE_BUNDLED"]);
    expect(e.svm.signAndSend(w.body.transaction, alice).ok).toBe(true);
    expect([yesOf(alice), noOf(alice)]).toEqual([0n, 0n]);
    expect(e.svm.usdc(alice) - start).toBe(6_000_000n);
  });

  it("RED-11 a trade for a maker with ledger funds bundles withdraw first, with LEDGER_WITHDRAW_BUNDLED", async () => {
    if (!r) return;
    const alice = e.svm.user("alice", 1_000n * USDC);
    await sync();
    await run(alice, "BUY_YES", "MARKET", 10, 64); // bob's ask fills: bob's ledger gets $6.40
    expect(e.svm.ledger(e.m, bob.publicKey)!.freeUsdc).toBe(6_400_000n);
    const res = await post(e.app, "/v1/tx/trade", trade(bob, e.mid, "SELL_YES", "LIMIT", 5, 70));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.warnings).toContain("LEDGER_WITHDRAW_BUNDLED");
    const d = decodeTx(res.body.transaction);
    expect(d.ixs.map((i) => i.name).slice(0, 1)).toEqual(["withdraw"]);
    expect(d.ixs.at(-1)!.name).toBe("place_order");
    const before = e.svm.usdc(bob);
    expect(e.svm.signAndSend(res.body.transaction, bob).ok).toBe(true);
    expect(e.svm.usdc(bob) - before).toBe(6_400_000n);
    // No ledger funds → no withdraw.
    const plain = await post(e.app, "/v1/tx/trade", trade(alice, e.mid, "BUY_YES", "LIMIT", 1, 50));
    expect(decodeTx(plain.body.transaction).ixs.map((i) => i.name)).toEqual(["place_order"]);
    expect(plain.body.warnings).toEqual([]);
  });

  it("CON-10 five parallel builds for one owner use the same confirmed state and give five distinct, valid txs", async () => {
    if (!r) return;
    const alice = e.svm.user("alice", 1_000n * USDC);
    await sync();
    const res = await Promise.all(Array.from({ length: 5 }, () => post(e.app, "/v1/tx/trade", trade(alice, e.mid, "BUY_YES", "LIMIT", 2, 55))));
    expect(res.map((x) => x.status)).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(res.map((x) => x.body.transaction)).size).toBe(5); // client ids differ, so no duplicate signature
    expect(new Set(res.map((x) => JSON.stringify(x.body.summary.maxCost))).size).toBe(1);
    for (const x of res) {
      expect(decodeTx(x.body.transaction).tx.message.recentBlockhash).toBeTruthy();
      expect(e.svm.signAndSend(x.body.transaction, alice).ok).toBe(true);
    }
    expect(e.svm.orders(e.m).filter((o) => o.owner === alice.publicKey.toBase58())).toHaveLength(5);
  });

  it("SEC-08 fuzzed bodies get 4xx with a code, never a 5xx or a transaction", async () => {
    if (!r) return;
    const alice = e.svm.user("alice", 1_000n * USDC);
    await sync();
    const base = trade(alice, e.mid, "BUY_YES", "LIMIT", 5, 50) as Record<string, unknown>;
    const values: unknown[] = [null, -1, 0, 1.5, 1e20, "5", "", [], {}, true, "x".repeat(5000), Number.NaN, 2 ** 53, "BUY_MAYBE", "11111111111111111111111111111111"];
    let seed = 42;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let i = 0; i < 300; i++) {
      const b: Record<string, unknown> = { ...base };
      for (let k = 0; k < 1 + rnd(3); k++) {
        const f = ["owner", "marketId", "intent", "orderType", "qty", "priceCents", "clientOrderId", "extra"][rnd(8)]!;
        if (rnd(5) === 0) delete b[f];
        else b[f] = values[rnd(values.length)];
      }
      const res = await e.app.inject({ method: "POST", url: "/v1/tx/trade", payload: b });
      expect(res.statusCode, JSON.stringify(b)).toBeLessThan(500);
      if (res.statusCode !== 200) {
        expect(res.json().error.code).toMatch(/^[A-Z_]+$/);
        expect(res.json().transaction).toBeUndefined();
      }
    }
    for (const raw of ["not json", "[]", "null", '{"qty":'] ) {
      const res = await e.app.inject({ method: "POST", url: "/v1/tx/trade", payload: raw, headers: { "content-type": "application/json" } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION");
    }
  });

  it("p99 build time stays under 30 ms", async () => {
    if (!r) return;
    const alice = e.svm.user("alice", 1_000n * USDC);
    await sync();
    const times: number[] = [];
    for (let i = 0; i < 120; i++) {
      const t0 = performance.now();
      await post(e.app, "/v1/tx/trade", trade(alice, e.mid, i % 2 ? "BUY_YES" : "BUY_NO", i % 3 ? "LIMIT" : "MARKET", 5, i % 2 ? 64 : 39));
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.99)]!).toBeLessThan(30);
  });

  it("makers are taken in price-time order and the build drops spares to stay under 1,232 bytes", async () => {
    if (!r) return;
    const makers = Array.from({ length: 30 }, (_, i) => e.svm.user(`mm${i}`, 100n * USDC));
    for (const [i, mm] of makers.entries()) {
      e.svm.mint(mm, e.m, 2n);
      e.svm.place(mm, e.m, "ask", 65 + (i % 5), 1n);
    }
    const alice = e.svm.user("alice", 1_000n * USDC);
    await sync();
    const res = await post(e.app, "/v1/tx/trade", trade(alice, e.mid, "BUY_YES", "MARKET", 80, 69));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Buffer.from(res.body.transaction, "base64").length).toBeLessThanOrEqual(1232);
    const ix = decodeTx(res.body.transaction).ixs.at(-1)!;
    const passed = ix.accounts.slice(19).map(String);
    // bob's 64 ask comes first, then the 65s in time order (mm0, mm5, ...).
    expect(passed[0]).toBe(ledgerPda(e.m.address, bob.publicKey).toBase58());
    expect(passed[1]).toBe(ledgerPda(e.m.address, makers[0]!.publicKey).toBase58());
    expect(e.svm.signAndSend(res.body.transaction, alice).ok).toBe(true);
    expect(yesOf(alice)).toBe(BigInt(50 + passed.length - 1));
    expect(new PublicKey(passed[0]!)).toBeTruthy();
  });
});
