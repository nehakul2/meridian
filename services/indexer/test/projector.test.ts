// MER-51: Redis projector (book, BBO, markets, trades, ticker-days, open orders, positions).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChainEvent } from "../../shared/src/events.js";
import { MemoryCursorStore } from "../src/cursor.js";
import { decodeTransaction } from "../src/decoder.js";
import { Indexer } from "../src/indexer.js";
import { K } from "../src/keys.js";
import { Projector } from "../src/projector.js";
import { EventStream } from "../src/stream.js";
import { allGroups, FakeChain, fixture, groupsThrough, quiet, tx } from "./helpers/fixture.js";
import { dumpRedis, startTestRedis, TestRedis } from "./helpers/redis.js";

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(here, "fixtures/day.redis.json");
const M = fixture.markets.m680;
const U = fixture.users;

/** Replaces pubkeys with fixture names so the golden file reads (and diffs) well. */
function named(v: unknown): unknown {
  let s = JSON.stringify(v);
  for (const [n, pk] of [...Object.entries(U), ...Object.entries(fixture.markets)]) s = s.replaceAll(pk, `<${n}>`);
  return JSON.parse(s);
}

const pos = async (r: TestRedis, who: keyof typeof U) => {
  const c = r.client();
  const s = await c.hget(K.pos(U[who]), M);
  return s ? JSON.parse(s) : null;
};

let n = 1000;
/** Synthetic market events for interleaving tests. */
function ev(kind: ChainEvent["kind"], seq: number, p: Record<string, string | number>): ChainEvent {
  return { sig: `s${seq}`, ix: 0, ev: 0, n: 1, slot: seq, blockTime: 1_800_000_000 + seq, commitment: "confirmed", kind, payload: { market: "Mkt", slot: String(seq), seq: String(seq), ...p } };
}

describe("projector", () => {
  let r: TestRedis | null;
  beforeAll(async () => {
    r = await startTestRedis();
  });
  afterAll(async () => r?.stop());
  beforeEach(async () => r?.flush());

  it("IDX-01 replaying the recorded day into empty Redis gives the golden md:* state", async () => {
    if (!r) return;
    const redis = r.client();
    const p = new Projector(redis, { now: () => 1_795_600_000_000 });
    for (const g of allGroups()) await p.applyInstruction(g);
    const got = named(await dumpRedis(redis));
    if (process.env.UPDATE_GOLDEN || !existsSync(GOLDEN)) writeFileSync(GOLDEN, JSON.stringify(got, null, 1) + "\n");
    expect(got).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));

    // Spot checks a reviewer can verify by hand (see scripts/record-fixture.rec.ts).
    expect(await redis.hgetall(K.mkt(M))).toMatchObject({ status: "SETTLED", outcome: "YES", book: "", pairs_outstanding: "105", volume: "40", last_cents: "65", seq: "27" });
    expect(await redis.exists(K.snap(M), K.bbo(M), K.lvl(M), K.bids(M), K.asks(M))).toBe(0); // BookClosed
    expect(await redis.hget(K.mkt(fixture.markets.m720), "status")).toBe("VOID");
    expect(await redis.hgetall(K.tday("META", 20261125))).toMatchObject({ status: "FINAL", final_basis: "CORRECTED", close_price: "685.12", original_price_raw: "68400000", dispute_result: "CORRECTED" });
    expect(await redis.hget(K.cfg, "paused")).toBe("0");
    expect(await redis.scard(K.dayMarkets(20261125))).toBe(9);
    expect(await redis.zrange(K.dayStrikes(20261125, "META"), 0, -1, "WITHSCORES")).toContain("68000");
    expect(await redis.llen(K.trades(M))).toBe(4);
    expect(await pos(r, "carol")).toMatchObject({ yes: 0, no: 5, avg_no: 39.61, realized: "-263000" });
    expect(await pos(r, "dave")).toMatchObject({ no: 10, avg_no: 35, ledger_usdc: "6500000", pending_no: 0 });
    expect(await pos(r, "bob")).toMatchObject({ yes: 10, ledger_yes: 10, ledger_usdc: "24400000" });
    expect(await pos(r, "alice")).toMatchObject({ yes: 0, no: 90, realized: "37800000", redeemed: true, ledger_usdc: "0" });
    expect(await pos(r, "frank")).toMatchObject({ yes: 0, no: 0, ledger_usdc: "2000000" });
    expect(await redis.hlen(K.oo(U.frank))).toBe(0);
  });

  it("TRD-16 / MER-51 BBO carries the No view: no_bid = 100 − ask, no_ask = 100 − bid", async () => {
    if (!r) return;
    const redis = r.client();
    const p = new Projector(redis, { now: () => 5 });
    for (const g of groupsThrough("bob bids 50 @ 61")) await p.applyInstruction(g);
    expect(await redis.hgetall(K.bbo(M))).toEqual({ bid: "61", bid_qty: "50", ask: "64", ask_qty: "20", no_bid: "36", no_ask: "39", mid: "62.5", seq: "4", ts: "5" });
    expect(JSON.parse((await redis.get(K.snap(M)))!)).toEqual({ seq: "4", bids: [[61, 50]], asks: [[64, 20]] });
    expect(await redis.hgetall(K.lvl(M))).toEqual({ "B:61": "50", "A:64": "20" });
    expect(await redis.zrange(K.bids(M), 0, -1)).toEqual(["61"]);
    expect(await redis.hlen(K.oo(U.bob))).toBe(1);
    // A resting Buy No limit is shown as pending on both legs.
    for (const g of groupsThrough("dave buy no limit 10 @ 65")) await p.applyInstruction(g);
    expect(await pos(r, "dave")).toMatchObject({ yes: 10, no: 10, pending_no: 10 });
    expect(JSON.parse((await redis.hget(K.oo(U.dave), `${M}:3`))!)).toMatchObject({ tag: "BUY_NO", intent: "BUY_NO", qty: 10 });
  });

  it("every market-scoped value carries a strictly increasing seq; a replay is a no-op", async () => {
    if (!r) return;
    const redis = r.client();
    const sub = r.client();
    const seqs: bigint[] = [];
    await sub.subscribe(K.ch.book(M));
    sub.on("message", (_c, msg) => seqs.push(BigInt(JSON.parse(msg).seq)));
    const p = new Projector(redis, { now: () => 1 });
    const groups = allGroups();
    for (const g of groups.slice(0, 20)) await p.applyInstruction(g);
    const before = await dumpRedis(redis);
    for (const g of groups.slice(0, 20)) await p.applyInstruction(g);
    expect(await dumpRedis(redis)).toEqual(before);
    await new Promise((res) => setTimeout(res, 50));
    expect(seqs.length).toBeGreaterThan(5);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]! > seqs[i - 1]!).toBe(true);
  });

  it("IDX-07 snapshot and delta never disagree under rapid interleaved changes", async () => {
    if (!r) return;
    const redis = r.client();
    const reader = r.client();
    const sub = r.client();
    const deltas: { seq: number; changes: [string, number, number][] }[] = [];
    await sub.subscribe(K.ch.book("Mkt"));
    sub.on("message", (_c, msg) => {
      const j = JSON.parse(msg);
      deltas.push({ seq: Number(j.seq), changes: j.changes });
    });
    const p = new Projector(redis, { now: () => 1 });
    await p.applyInstruction([ev("MarketCreated", 1, { ticker: "META", date: 20261125, strike_cents: "68000", yes_mint: "y", no_mint: "n", vault: "v", book: "b", ticker_day: "td", created_by: "c" })]);
    // A reader keeps taking snapshots while 300 book changes land.
    const snaps: { seq: number; bids: [number, number][]; asks: [number, number][] }[] = [];
    let writing = true;
    const readLoop = (async () => {
      while (writing) {
        const s = await reader.get(K.snap("Mkt"));
        if (s) snaps.push({ ...JSON.parse(s), seq: Number(JSON.parse(s).seq) });
      }
    })();
    let rnd = 7;
    const rand = (k: number) => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31), rnd % k);
    const resting: { id: number; side: "BID" | "ASK"; price: number; qty: number }[] = [];
    for (let s = 2; s < 302; s++) {
      if (resting.length > 0 && rand(3) === 0) {
        const o = resting.splice(rand(resting.length), 1)[0]!;
        await p.applyInstruction([ev("OrderCancelled", s, { order_id: String(o.id), owner: "u", side: o.side, price: o.price, qty: String(o.qty), reason: "USER" })]);
      } else {
        const side = rand(2) ? "BID" : "ASK";
        const o = { id: n++, side, price: side === "BID" ? 30 + rand(20) : 51 + rand(20), qty: 1 + rand(9) } as const;
        resting.push(o);
        await p.applyInstruction([ev("OrderPlaced", s, { order_id: String(o.id), owner: "u", side, price: o.price, qty: String(o.qty), tif: "GTC", tag: "NONE", client_id: "0" })]);
      }
    }
    writing = false;
    await readLoop;
    await new Promise((res) => setTimeout(res, 100));
    const final = JSON.parse((await redis.get(K.snap("Mkt")))!);
    expect(deltas.map((d) => d.seq)).toEqual(Array.from({ length: 300 }, (_, i) => i + 2));
    expect(snaps.length).toBeGreaterThan(10);
    // Any snapshot plus the deltas after its seq reproduces the final book exactly.
    const key = (b: [number, number][], a: [number, number][]) => JSON.stringify([b, a]);
    for (const s of snaps) {
      const lv = new Map<string, number>([...s.bids.map(([pr, q]) => [`B:${pr}`, q] as const), ...s.asks.map(([pr, q]) => [`A:${pr}`, q] as const)]);
      for (const d of deltas.filter((x) => x.seq > s.seq)) for (const [sd, pr, q] of d.changes) q > 0 ? lv.set(`${sd}:${pr}`, q) : lv.delete(`${sd}:${pr}`);
      const bids = [...lv].filter(([k]) => k[0] === "B").map(([k, q]) => [Number(k.slice(2)), q] as [number, number]).sort((a, b) => b[0] - a[0]);
      const asks = [...lv].filter(([k]) => k[0] === "A").map(([k, q]) => [Number(k.slice(2)), q] as [number, number]).sort((a, b) => a[0] - b[0]);
      expect(key(bids.slice(0, 20), asks.slice(0, 20))).toBe(key(final.bids, final.asks));
    }
  });

  it("md:book:{m}:* and md:bbo are deleted on BookClosed", async () => {
    if (!r) return;
    const redis = r.client();
    const p = new Projector(redis, { now: () => 1 });
    const groups = allGroups();
    const closeIdx = groups.findIndex((g) => g.some((e) => e.kind === "BookClosed" && e.payload.market === M));
    for (const g of groups.slice(0, closeIdx)) await p.applyInstruction(g);
    // Frank's resting Buy No was pruned just before; put a level back to prove deletion.
    await redis.hset(K.lvl(M), "A:90", "2");
    await redis.set(K.snap(M), "{}");
    await p.applyInstruction(groups[closeIdx]!);
    expect(await redis.keys(`md:book:${M}:*`)).toEqual([]);
    expect(await redis.exists(K.bbo(M))).toBe(0);
    expect(await redis.hget(K.mkt(M), "book")).toBe("");
  });

  it("an account change at confirmed reaches Redis in < 50 ms on the fixture", async () => {
    if (!r) return;
    const redis = r.client();
    const idx = new Indexer({ redis, source: new FakeChain(), cursor: new MemoryCursorStore(), projector: new Projector(redis), stream: new EventStream(redis), log: quiet });
    const times: number[] = [];
    for (const t of fixture.txs) {
      const t0 = performance.now();
      await idx.processTransaction(t, "confirmed");
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(50);
  });

  it("IDX-05 a confirmed signature that never finalizes is removed from Redis and clients get a correction", async () => {
    if (!r) return;
    const redis = r.client();
    const chain = new FakeChain(fixture.txs.slice(0, 1 + fixture.txs.findIndex((t) => t.label === "carol sell no 5")));
    const stream = new EventStream(redis);
    const idx = new Indexer({ redis, source: chain, cursor: new MemoryCursorStore(), projector: new Projector(redis, { now: () => 1 }), stream, log: quiet });
    for (const t of chain.txs) await idx.processTransaction(t, "confirmed");
    expect(await pos(r, "carol")).toMatchObject({ no: 5 });
    const sub = r.client();
    const msgs: string[] = [];
    await sub.psubscribe("md:ch:*");
    sub.on("pmessage", (_p, ch, m) => msgs.push(`${ch} ${m}`));
    // carol's Sell No lands at confirmed, then the fork drops it.
    const sellNo = tx("carol sell no 5");
    chain.dropped.add(sellNo.signature);
    chain.finalizedSlot = sellNo.slot + 10;
    const out = await idx.checkFinality();
    expect(out.dropped).toBe(1);
    const withEvents = chain.txs.filter((t) => decodeTransaction(t, "confirmed", quiet).length > 0).length;
    expect(out.finalized).toBe(withEvents - 1);
    expect(idx.pending.size).toBe(0);
    expect(await pos(r, "carol")).toMatchObject({ no: 10, avg_no: 39.61, realized: "0" });
    expect(await pos(r, "dave")).toMatchObject({ yes: 5, pending_no: 5, ledger_usdc: "3250000" }); // 5 of his Buy No back to resting
    expect(JSON.parse((await redis.get(K.snap(M)))!)).toMatchObject({ seq: "10", bids: [[61, 40]], asks: [[65, 5]] });
    await new Promise((res) => setTimeout(res, 50));
    expect(msgs.some((m) => m.startsWith(K.ch.book(M)) && m.includes("book_snapshot"))).toBe(true);
    expect(msgs.some((m) => m.startsWith(K.ch.user(U.carol)) && m.includes("correction"))).toBe(true);
    const entries = await redis.xrange("md:events", "-", "+");
    expect(entries.filter(([, f]) => f.includes("Dropped")).length).toBe(1);
  });
});
