// MER-53: idempotent md:events consumer, seq gap backfill, reorg handling, candles, lag.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ChainEvent, STREAM_KEY, STREAM_MAXLEN, StreamEntry, toFields } from "../../shared/src/events.js";
import { RedisBackfiller, StreamConsumer } from "../src/consumer.js";
import { Backfiller, PgWriter } from "../src/writer.js";
import { day, events, groups, groupsOf, sigOf } from "./helpers/fixture.js";
import { dumpTables, startTestDb, TestDb } from "./helpers/pg.js";
import { startTestRedis, TestRedis } from "./helpers/redis.js";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "fixtures/day.tables.json");
const M = day.markets.m680;
const U = day.users;
const quiet = { warn: () => undefined, info: () => undefined };

async function push(redis: Redis, list: (ChainEvent | StreamEntry)[]) {
  for (const e of list) await redis.xadd(STREAM_KEY, "*", ...toFields("type" in e ? e : { type: "event", ...e }));
}

/** Names instead of pubkeys/signatures, so the golden file reads well and diffs cleanly. */
function named(v: unknown): unknown {
  let s = JSON.stringify(v);
  for (const [n, pk] of [...Object.entries(U), ...Object.entries(day.markets)]) s = s.replaceAll(pk, `<${n}>`);
  day.txs.forEach((t, i) => (s = s.replaceAll(t.signature, `<tx${i}:${t.label}>`)));
  return JSON.parse(s);
}

describe("pg-writer consumer", () => {
  let db: TestDb | null;
  let r: TestRedis | null;
  beforeAll(async () => {
    db = await startTestDb();
    r = await startTestRedis();
  });
  afterAll(async () => {
    await db?.stop();
    await r?.stop();
  });
  beforeEach(async () => {
    if (!db || !r) return;
    await r.flush();
    await db.pool.query("TRUNCATE chain_events, positions, fills, orders, mint_merge_redeem, candles_1m, disputes, markets, ticker_days, indexer_cursor CASCADE");
  });

  const ready = () => !!db && !!r;
  const setup = (bf?: Backfiller) => {
    const redis = r!.client();
    const writer = new PgWriter(db!.pool, bf ?? new RedisBackfiller(redis), { log: quiet });
    return { redis, writer, consumer: new StreamConsumer(redis, writer, db!.pool) };
  };

  it("IDX-01 replaying the recorded day gives the golden tables", async () => {
    if (!ready()) return;
    const { redis, consumer } = setup();
    await push(redis, events);
    await consumer.drain();
    const got = named(await dumpTables(db!.pool));
    if (process.env.UPDATE_GOLDEN || !existsSync(GOLDEN)) writeFileSync(GOLDEN, JSON.stringify(got, null, 1) + "\n");
    expect(got).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));

    const q = (sql: string, p: unknown[] = []) => db!.pool.query(sql, p).then((x) => x.rows);
    expect(await q("SELECT status, outcome, book, pairs_outstanding, total_volume_contracts FROM markets WHERE pda = $1", [M]))
      .toEqual([{ status: "SETTLED", outcome: "YES", book: null, pairs_outstanding: "105", total_volume_contracts: "40" }]);
    expect(await q("SELECT count(*)::int AS n FROM markets")).toEqual([{ n: 9 }]);
    expect(await q("SELECT status FROM markets WHERE pda = $1", [day.markets.m720])).toEqual([{ status: "VOID" }]);
    expect(await q("SELECT status, final_basis, close_price_raw, original_price_raw, close_price::text AS p FROM ticker_days"))
      .toEqual([{ status: "FINAL", final_basis: "CORRECTED", close_price_raw: "68512000", original_price_raw: "68400000", p: "685.12000000" }]);
    expect(await q("SELECT result, old_price_raw, new_price_raw, bond_micro FROM disputes"))
      .toEqual([{ result: "CORRECTED", old_price_raw: "68400000", new_price_raw: "68512000", bond_micro: "100000000" }]);
    expect(await q("SELECT count(*)::int AS n, count(*) FILTER (WHERE commitment = 'confirmed')::int AS c FROM chain_events"))
      .toEqual([{ n: events.length, c: events.length }]);
    expect(await q("SELECT kind, via, usdc_micro FROM mint_merge_redeem WHERE owner = $1 ORDER BY signature, event_index", [U.alice]))
      .toEqual(expect.arrayContaining([
        { kind: "MINT", via: "DIRECT", usdc_micro: "-100000000" }, { kind: "WITHDRAW", via: null, usdc_micro: "12800000" },
        { kind: "REDEEM", via: null, usdc_micro: "70000000" },
      ]));
    // orders: bob's bid filled 10 then cancelled; frank's Buy No pruned.
    expect(await q("SELECT owner, qty_original, qty_filled, status, cancel_reason, intent FROM orders WHERE owner IN ($1, $2) ORDER BY order_id", [U.bob, U.frank]))
      .toEqual([
        { owner: U.bob, qty_original: "50", qty_filled: "10", status: "CANCELLED", cancel_reason: "USER", intent: "BUY_YES" },
        { owner: U.frank, qty_original: "2", qty_filled: "0", status: "CANCELLED", cancel_reason: "PRUNE", intent: "BUY_NO" },
      ]);
    const cur = await q("SELECT last_stream_id FROM indexer_cursor WHERE stream = 'redis_stream'");
    expect(cur[0].last_stream_id).toBe((await redis.xrevrange(STREAM_KEY, "+", "-", "COUNT", 1))[0]![0]);
  });

  it("IDX-03 the same events delivered twice (and the stream replayed) leave every table identical", async () => {
    if (!ready()) return;
    const { redis, consumer, writer } = setup();
    await push(redis, events);
    await consumer.drain();
    const once = await dumpTables(db!.pool);
    // Duplicate delivery of one event and a full replay of every instruction.
    await push(redis, groupsOf("carol buy no market 10").flat());
    await consumer.drain();
    for (const g of groups()) expect(await writer.apply(g)).toBe(false);
    expect(await dumpTables(db!.pool)).toEqual(once);
    const fills = await db!.pool.query("SELECT count(*)::int AS n FROM fills");
    expect(fills.rows[0].n).toBe(4);
  });

  it("IDX-04 a per-market seq gap holds later events, requests a backfill, then applies in order", async () => {
    if (!ready()) return;
    const requests: [string, bigint, bigint][] = [];
    const missing = groupsOf("erin buys yes ioc 25 @ 65").flat(); // seq 9 and 10 of M
    const bf: Backfiller = {
      async request(m, from, to) {
        requests.push([m, from, to]);
      },
    };
    const { redis, consumer } = setup(bf);
    const all = events.filter((e) => !missing.includes(e));
    await push(redis, all);
    await consumer.drain();
    expect(requests).toEqual([[M, 9n, 10n]]);
    // Nothing after the gap is in the market's tables yet (carol's Sell No is seq 11-12).
    const before = await db!.pool.query("SELECT max(seq)::int AS s FROM chain_events WHERE market_pda = $1", [M]);
    expect(before.rows[0].s).toBe(8);
    // The Indexer serves the request: the missing instruction arrives late on the stream.
    await push(redis, missing);
    await consumer.drain();
    const gapRun = await dumpTables(db!.pool);
    await db!.pool.query("TRUNCATE chain_events, positions, fills, orders, mint_merge_redeem, candles_1m, disputes, markets, ticker_days CASCADE");
    const inOrder = new PgWriter(db!.pool, bf, { log: quiet });
    for (const g of groups()) await inOrder.handle(g);
    expect(gapRun).toEqual(await dumpTables(db!.pool));
    expect(requests).toHaveLength(1);
    // Every stream entry ended up acknowledged.
    const pending = (await redis.xpending(STREAM_KEY, "pgw")) as [number, ...unknown[]];
    expect(pending[0]).toBe(0);
  });

  it("IDX-05 a confirmed signature missing at finalization is deleted and positions rebuilt; Finalized promotes the rest", async () => {
    if (!ready()) return;
    const { redis, consumer } = setup();
    const upto = events.filter((e) => e.slot <= events.find((x) => x.sig === sigOf("carol sell no 5"))!.slot);
    await push(redis, upto);
    await consumer.drain();
    const pos = async (who: keyof typeof U) =>
      (await db!.pool.query("SELECT yes_qty, no_qty, no_cost_micro, realized_pnl_micro, ledger_free_usdc FROM positions WHERE owner = $1 AND market_pda = $2", [U[who], M])).rows[0];
    expect(await pos("carol")).toMatchObject({ no_qty: "5", realized_pnl_micro: "-263000" });
    const sell = sigOf("carol sell no 5");
    const others = [...new Set(upto.map((e) => e.sig))].filter((s) => s !== sell);
    await push(redis, [
      ...others.map((sig) => ({ type: "control", sig, slot: 0, kind: "Finalized", commitment: "finalized" }) as StreamEntry),
      { type: "control", sig: sell, slot: 0, kind: "Dropped", commitment: "confirmed" },
    ]);
    await consumer.drain();
    expect((await db!.pool.query("SELECT count(*)::int AS n FROM chain_events WHERE signature = $1", [sell])).rows[0].n).toBe(0);
    expect((await db!.pool.query("SELECT count(*)::int AS n FROM fills WHERE signature = $1", [sell])).rows[0].n).toBe(0);
    expect((await db!.pool.query("SELECT DISTINCT commitment FROM chain_events")).rows).toEqual([{ commitment: "finalized" }]);
    expect(await pos("carol")).toMatchObject({ yes_qty: "0", no_qty: "10", no_cost_micro: "3961000", realized_pnl_micro: "0" });
    expect(await pos("dave")).toMatchObject({ yes_qty: "5", no_qty: "10", ledger_free_usdc: "3250000" });
    const o = await db!.pool.query("SELECT qty_filled, status FROM orders WHERE market_pda = $1 AND order_id = 3", [M]);
    expect(o.rows[0]).toEqual({ qty_filled: "5", status: "PARTIAL" });
    // Same result as never having seen the dropped signature.
    const rebuilt = await dumpTables(db!.pool);
    await db!.pool.query("TRUNCATE chain_events, positions, fills, orders, mint_merge_redeem, candles_1m, disputes, markets, ticker_days CASCADE");
    const clean = new PgWriter(db!.pool, new RedisBackfiller(redis), { log: quiet });
    for (const g of groups().filter((g) => g[0]!.slot <= upto.at(-1)!.slot && g[0]!.sig !== sell)) await clean.handle(g);
    await db!.pool.query("UPDATE chain_events SET commitment = 'finalized'");
    expect(await dumpTables(db!.pool)).toEqual(rebuilt);
  });

  it("candles bucket fills by minute: open/close by seq, high/low, volume", async () => {
    if (!ready()) return;
    const { redis, consumer } = setup();
    await push(redis, events);
    await consumer.drain();
    const c = await db!.pool.query("SELECT bucket, o, h, l, c, volume FROM candles_1m WHERE market_pda = $1 ORDER BY bucket", [M]);
    const t = (label: string) => events.find((e) => e.sig === sigOf(label))!.blockTime!;
    const b = (s: number) => new Date(Math.floor(s / 60) * 60_000).toISOString();
    expect(c.rows.map((x) => ({ ...x, bucket: (x.bucket as Date).toISOString() }))).toEqual([
      { bucket: b(t("carol buy no market 10")), o: 61, h: 61, l: 61, c: 61, volume: "10" },
      { bucket: b(t("erin buys yes ioc 25 @ 65")), o: 64, h: 65, l: 64, c: 65, volume: "30" },
    ]);
  });

  it("a crash between commit and ack replays as a no-op (pending entries are re-read first)", async () => {
    if (!ready()) return;
    const { redis, writer } = setup();
    await push(redis, events.slice(0, 20));
    // First consumer reads but "crashes" before acking: simulate by reading without processing.
    await redis.xgroup("CREATE", STREAM_KEY, "pgw", "0", "MKSTREAM");
    await redis.xreadgroup("GROUP", "pgw", "pgw-1", "COUNT", 5, "STREAMS", STREAM_KEY, ">");
    for (const g of groups().slice(0, 3)) await writer.apply(g); // committed, not acked
    const c2 = new StreamConsumer(redis, writer, db!.pool, "pgw-1");
    await c2.drain();
    const pending = (await redis.xpending(STREAM_KEY, "pgw")) as [number, ...unknown[]];
    expect(pending[0]).toBe(0);
    const n = await db!.pool.query("SELECT count(*)::int AS n FROM chain_events");
    expect(n.rows[0].n).toBe(20);
  });

  it("SCL-07 event → PG row under 2 s at p95 on a loaded stream; MAXLEN not exceeded", async () => {
    if (!ready()) return;
    const { redis, consumer } = setup();
    consumer.trackLag = true;
    // The day ten times over (distinct signatures), appended while the consumer runs.
    const many: ChainEvent[] = [];
    for (let k = 0; k < 10; k++) {
      for (const e of events) {
        const p = { ...e.payload };
        if (Number(p.seq) > 0) p.market = `${p.market}-${k}`; // market events go to copy k of the market
        if (e.kind === "MarketCreated") Object.assign(p, { strike_cents: String(Number(p.strike_cents) + (k + 1) * 1_000_000), yes_mint: `${p.yes_mint}-${k}`, no_mint: `${p.no_mint}-${k}` });
        many.push({ ...e, sig: `${e.sig}-${k}`, payload: p });
      }
    }
    const running = (async () => {
      for (let i = 0; i < 40; i++) {
        await consumer.poll(50);
      }
    })();
    for (let i = 0; i < many.length; i += 25) await push(redis, many.slice(i, i + 25));
    await running;
    await consumer.drain();
    const lags = [...consumer.committedAt].map(([id, at]) => at - Number(id.split("-")[0]));
    expect(lags.length).toBe(many.length);
    lags.sort((a, b) => a - b);
    expect(lags[Math.floor(lags.length * 0.95)]!).toBeLessThan(2000);
    expect(await redis.xlen(STREAM_KEY)).toBeLessThanOrEqual(STREAM_MAXLEN);
  });
});
