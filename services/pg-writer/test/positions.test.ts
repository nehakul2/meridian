// MER-54: positions, intent mapping and P&L (shared engine, and as the PG Writer stores it).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChainEvent } from "../../shared/src/events.js";
import {
  applyInstruction, MarketState, MICRO_PER_CENT, positionView, PositionState,
} from "../../shared/src/positions.js";
import { PgWriter } from "../src/writer.js";
import { day, groups, groupsThrough } from "./helpers/fixture.js";
import { startTestDb, TestDb } from "./helpers/pg.js";

const M = "Mkt";
let seq = 1;
let sigN = 0;
/** One synthetic instruction: events get consecutive seqs on market M. */
function ix(...evs: [ChainEvent["kind"], Record<string, string | number>][]): ChainEvent[] {
  const sig = `sig${sigN++}`;
  return evs.map(([kind, p], i) => ({
    sig, ix: 0, ev: i, n: evs.length, slot: seq, blockTime: 1_800_000_000 + seq, commitment: "confirmed", kind,
    payload: { market: M, slot: String(seq), seq: String(seq++), ...p },
  }));
}
const fresh = (): MarketState => ({ orders: new Map(), positions: new Map() });
const c = (cents: number) => BigInt(cents) * MICRO_PER_CENT;
const fee = (price: number, qty: number, bps = 100) => (BigInt(price) * MICRO_PER_CENT * BigInt(qty) * BigInt(bps)) / 10_000n;

// Order book helpers: a maker rests, a taker crosses.
function rest(s: MarketState, owner: string, id: number, side: "BID" | "ASK", price: number, qty: number, tag = "NONE") {
  applyInstruction(s, ix(["OrderPlaced", { order_id: String(id), owner, side, price, qty: String(qty), tif: "GTC", tag, client_id: "0" }]));
}
function takerFill(maker: string, taker: string, id: number, side: "BID" | "ASK", price: number, qty: number, takerFee = 0n): [ChainEvent["kind"], Record<string, string | number>] {
  return ["Fill", { maker_order_id: String(id), maker, taker, side, price, qty: String(qty), taker_fee: takerFee.toString() }];
}
const P = (s: MarketState, o: string) => s.positions.get(o) as PositionState;

describe("positions engine", () => {
  it("IDX-08 Buy Yes 10 @ 60, 10 @ 70, Sell Yes 5 @ 80: avg entry 65, realized 5 × 15 = 75 cents", () => {
    const s = fresh();
    rest(s, "mm", 1, "ASK", 60, 10);
    applyInstruction(s, ix(takerFill("mm", "alice", 1, "BID", 60, 10)));
    rest(s, "mm", 2, "ASK", 70, 10);
    applyInstruction(s, ix(takerFill("mm", "alice", 2, "BID", 70, 10)));
    expect(positionView(P(s, "alice"), null)).toMatchObject({ side: "YES", qty: 20n, avgEntryCents: 65 });
    rest(s, "mm", 3, "BID", 80, 5);
    applyInstruction(s, ix(takerFill("mm", "alice", 3, "ASK", 80, 5)));
    expect(P(s, "alice")).toMatchObject({ yes: 15n, yesCost: c(65) * 15n, realized: c(15) * 5n });
    expect(positionView(P(s, "alice"), null).avgEntryCents).toBe(65);
  });

  it("IDX-08 fees are in the cost basis and reduce realized P&L (1% taker fee)", () => {
    const s = fresh();
    rest(s, "mm", 1, "ASK", 60, 10);
    applyInstruction(s, ix(takerFill("mm", "alice", 1, "BID", 60, 10, fee(60, 10))));
    rest(s, "mm", 2, "ASK", 70, 10);
    applyInstruction(s, ix(takerFill("mm", "alice", 2, "BID", 70, 10, fee(70, 10))));
    expect(P(s, "alice").yesCost).toBe(c(1300) + fee(60, 10) + fee(70, 10)); // 13.13 USDC
    expect(positionView(P(s, "alice"), null).avgEntryCents).toBeCloseTo(65.65, 10);
    rest(s, "mm", 3, "BID", 80, 5);
    applyInstruction(s, ix(takerFill("mm", "alice", 3, "ASK", 80, 5, fee(80, 5))));
    // 5 × 80 − 0.04 fee − 5 × 65.65 = 0.6775 USDC
    expect(P(s, "alice").realized).toBe(677_500n);
    // The maker pays no fee and gets proceeds in its ledger.
    expect(P(s, "mm").ledgerUsdc).toBe(c(60) * 10n + c(70) * 10n);
  });

  it("IDX-02 / IDX-08 Buy No market at Yes 61 books No at 39 per token (plus fee), never as a Yes sale", () => {
    const s = fresh();
    rest(s, "bob", 1, "BID", 61, 10);
    const out = applyInstruction(s, ix(["PairMinted", { owner: "carol", n: "10", via: "BUY_NO" }], takerFill("bob", "carol", 1, "ASK", 61, 10, fee(61, 10))));
    expect(out.fills[0]).toMatchObject({ takerIntent: "BUY_NO", makerIntent: "BUY_YES", price: 61 });
    expect(P(s, "carol")).toMatchObject({ yes: 0n, no: 10n, noCost: c(39) * 10n + fee(61, 10), realized: 0n });
    expect(positionView(P(s, "carol"), null)).toMatchObject({ side: "NO", qty: 10n });
    expect(positionView(P(s, "carol"), null).avgEntryCents).toBeCloseTo(39.61, 10);
    expect(P(s, "bob")).toMatchObject({ yes: 10n, yesCost: c(61) * 10n, ledgerYes: 10n });
    expect(out.mmr).toEqual([expect.objectContaining({ kind: "MINT", via: "BUY_NO", usdc: -10_000_000n })]);
  });

  it("IDX-02 Sell No (buy Yes + merge) realizes (100 − price) − fees − No basis", () => {
    const s = fresh();
    rest(s, "bob", 1, "BID", 61, 10);
    applyInstruction(s, ix(["PairMinted", { owner: "carol", n: "10", via: "BUY_NO" }], takerFill("bob", "carol", 1, "ASK", 61, 10)));
    rest(s, "mm", 2, "ASK", 65, 4);
    const out = applyInstruction(s, ix(takerFill("mm", "carol", 2, "BID", 65, 4, fee(65, 4)), ["PairMerged", { owner: "carol", n: "4", via: "SELL_NO" }]));
    expect(out.fills[0]).toMatchObject({ takerIntent: "SELL_NO", makerIntent: "SELL_YES" });
    // No sold at 35 against a 39 basis, minus the fee: 4 × (35 − 39) − 0.026 = −0.186 USDC
    expect(P(s, "carol")).toMatchObject({ yes: 0n, no: 6n, noCost: c(39) * 6n, realized: c(-4) * 4n - fee(65, 4) });
    expect(out.mmr).toEqual([expect.objectContaining({ kind: "MERGE", via: "SELL_NO", usdc: 4_000_000n })]);
  });

  it("POS-05 a resting Buy No limit is BOTH_PENDING; maker fills settle it through the ledger before withdraw", () => {
    const s = fresh();
    applyInstruction(s, ix(["PairMinted", { owner: "dave", n: "10", via: "BUY_NO" }],
      ["OrderPlaced", { order_id: "7", owner: "dave", side: "ASK", price: 65, qty: "10", tif: "GTC", tag: "BUY_NO", client_id: "0" }]));
    expect(positionView(P(s, "dave"), 63)).toMatchObject({ side: "BOTH_PENDING", qty: 10n, avgEntryCents: null, unrealizedPnl: 0n });
    expect(s.orders.get(7n)).toMatchObject({ intent: "BUY_NO", status: "OPEN" });
    const out = applyInstruction(s, ix(takerFill("dave", "erin", 7, "BID", 65, 4)));
    expect(out.fills[0]).toMatchObject({ makerIntent: "BUY_NO", takerIntent: "BUY_YES" });
    expect(P(s, "dave")).toMatchObject({ yes: 6n, no: 10n, pendingNo: 6n, ledgerUsdc: c(65) * 4n });
    expect(positionView(P(s, "dave"), 63)).toMatchObject({ side: "BOTH_PENDING", qty: 10n, avgEntryCents: 35 });
    // The rest fills: a plain No position at 35, proceeds still unclaimed in the ledger.
    applyInstruction(s, ix(takerFill("dave", "erin", 7, "BID", 65, 6)));
    expect(positionView(P(s, "dave"), 63)).toMatchObject({ side: "NO", qty: 10n, avgEntryCents: 35, unrealizedPnl: (c(37) - c(35)) * 10n });
    expect(P(s, "dave").ledgerUsdc).toBe(c(65) * 10n);
    applyInstruction(s, ix(["Withdrawn", { owner: "dave", usdc: (c(65) * 10n).toString(), yes: "0" }]));
    expect(P(s, "dave")).toMatchObject({ ledgerUsdc: 0n, no: 10n });
  });

  it("cancelling an unfilled Buy No limit returns the $1 per pair with no P&L", () => {
    const s = fresh();
    applyInstruction(s, ix(["PairMinted", { owner: "dave", n: "3", via: "BUY_NO" }],
      ["OrderPlaced", { order_id: "9", owner: "dave", side: "ASK", price: 70, qty: "3", tif: "GTC", tag: "BUY_NO", client_id: "0" }]));
    applyInstruction(s, ix(["OrderCancelled", { order_id: "9", owner: "dave", side: "ASK", price: 70, qty: "3", reason: "USER" }],
      ["PairMerged", { owner: "dave", n: "3", via: "CANCEL_BUY_NO" }]));
    expect(P(s, "dave")).toMatchObject({ yes: 0n, no: 0n, noCost: 0n, yesCost: 0n, realized: 0n, pendingNo: 0n, ledgerYes: 0n });
    expect(s.orders.get(9n)).toMatchObject({ status: "CANCELLED", cancelReason: "USER" });
  });

  it("redeem: the winner realizes payout − basis; the loser realizes −basis", () => {
    const s = fresh();
    applyInstruction(s, ix(["PairMinted", { owner: "alice", n: "10", via: "DIRECT" }])); // 50/50 split of $1
    applyInstruction(s, ix(["MarketSettled", { outcome: "YES", settle_price: "68512000" }]));
    expect(positionView(P(s, "alice"), 100)).toMatchObject({ unrealizedPnl: c(50) * 10n - c(50) * 10n });
    applyInstruction(s, ix(["Redeemed", { owner: "alice", yes_n: "10", no_n: "0", paid: "10000000" }]));
    expect(P(s, "alice")).toMatchObject({ yes: 0n, realized: c(50) * 10n, redeemed: true });
    applyInstruction(s, ix(["Redeemed", { owner: "alice", yes_n: "0", no_n: "10", paid: "0" }]));
    expect(P(s, "alice")).toMatchObject({ no: 0n, noCost: 0n, realized: 0n }); // +5.00 then −5.00
  });

  it("unrealized P&L is against the mark: Yes at mark, No at 100 − mark", () => {
    const s = fresh();
    rest(s, "mm", 1, "ASK", 60, 10);
    applyInstruction(s, ix(takerFill("mm", "alice", 1, "BID", 60, 10)));
    expect(positionView(P(s, "alice"), 63).unrealizedPnl).toBe(c(3) * 10n);
    expect(positionView(P(s, "alice"), 55).unrealizedPnl).toBe(c(-5) * 10n);
  });
});

describe("positions in Postgres (recorded day)", () => {
  let db: TestDb | null;
  beforeAll(async () => {
    db = await startTestDb();
  });
  afterAll(async () => db?.stop());
  const U = day.users;
  const M680 = day.markets.m680;

  it("IDX-02 orders and fills carry the user's intent: BUY_NO at No price 39, SELL_NO, never a Yes sale", async () => {
    if (!db) return;
    const w = new PgWriter(db.pool, { request: async () => undefined }, { log: { warn: () => undefined } });
    for (const g of groups()) await w.handle(g);
    const f = await db.pool.query("SELECT taker, maker, taker_intent, maker_intent, price_cents, taker_fee_micro FROM fills ORDER BY seq");
    expect(f.rows).toEqual([
      { taker: U.carol, maker: U.bob, taker_intent: "BUY_NO", maker_intent: "BUY_YES", price_cents: 61, taker_fee_micro: "61000" },
      { taker: U.erin, maker: U.alice, taker_intent: "BUY_YES", maker_intent: "SELL_YES", price_cents: 64, taker_fee_micro: "128000" },
      { taker: U.erin, maker: U.dave, taker_intent: "BUY_YES", maker_intent: "BUY_NO", price_cents: 65, taker_fee_micro: "32500" },
      { taker: U.carol, maker: U.dave, taker_intent: "SELL_NO", maker_intent: "BUY_NO", price_cents: 65, taker_fee_micro: "32500" },
    ]);
    expect(100 - f.rows[0].price_cents).toBe(39);
    const o = await db.pool.query("SELECT owner, intent, tag FROM orders WHERE owner = $1 ORDER BY order_id", [U.dave]);
    expect(o.rows).toEqual([{ owner: U.dave, intent: "BUY_NO", tag: "BUY_NO" }, { owner: U.dave, intent: "BUY_NO", tag: "BUY_NO" }]);
    const pos = await db.pool.query("SELECT owner, yes_qty, no_qty, yes_cost_micro, no_cost_micro, realized_pnl_micro, ledger_free_usdc, ledger_free_yes, redeemed FROM positions WHERE market_pda = $1", [M680]);
    const by = Object.fromEntries(pos.rows.map((r) => [Object.entries(U).find(([, v]) => v === r.owner)![0], r]));
    expect(by.carol).toMatchObject({ yes_qty: "0", no_qty: "5", no_cost_micro: "1980500", realized_pnl_micro: "-263000" });
    expect(by.dave).toMatchObject({ yes_qty: "0", no_qty: "10", no_cost_micro: "3500000", ledger_free_usdc: "6500000" });
    expect(by.bob).toMatchObject({ yes_qty: "10", ledger_free_yes: "10", ledger_free_usdc: "24400000" });
    expect(by.erin).toMatchObject({ yes_qty: "25", yes_cost_micro: "16210500" });
    expect(by.alice).toMatchObject({ yes_qty: "0", no_qty: "90", realized_pnl_micro: "37800000", redeemed: true, ledger_free_usdc: "0" });
    expect(by.frank).toMatchObject({ yes_qty: "0", no_qty: "0", ledger_free_usdc: "2000000" });
  });

  it("POS-05 while dave's Buy No limit rests, Postgres shows BOTH_PENDING (pending derived from open BUY_NO orders)", async () => {
    if (!db) return;
    await db.pool.query("TRUNCATE chain_events, positions, fills, orders, mint_merge_redeem, candles_1m, disputes, markets, ticker_days CASCADE");
    const w = new PgWriter(db.pool, { request: async () => undefined }, { log: { warn: () => undefined } });
    for (const g of groupsThrough("erin buys yes ioc 25 @ 65")) await w.handle(g);
    const r = await db.pool.query("SELECT * FROM positions WHERE owner = $1", [U.dave]);
    const o = await db.pool.query("SELECT qty_original - qty_filled AS open FROM orders WHERE owner = $1 AND status IN ('OPEN','PARTIAL')", [U.dave]);
    expect(o.rows).toEqual([{ open: "5" }]);
    const p: PositionState = {
      owner: U.dave, market: M680, yes: BigInt(r.rows[0].yes_qty), no: BigInt(r.rows[0].no_qty), yesCost: BigInt(r.rows[0].yes_cost_micro),
      noCost: BigInt(r.rows[0].no_cost_micro), realized: 0n, ledgerUsdc: BigInt(r.rows[0].ledger_free_usdc), ledgerYes: 0n,
      pendingNo: BigInt(o.rows[0].open), redeemed: false, lastSeq: 0n, updatedAt: 0,
    };
    expect(positionView(p, 63)).toMatchObject({ side: "BOTH_PENDING", qty: 10n, avgEntryCents: 35 });
    expect(p.ledgerUsdc).toBe(c(65) * 5n); // maker fill visible via the ledger before any withdraw
  });
});
