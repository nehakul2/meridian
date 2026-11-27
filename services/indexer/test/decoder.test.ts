// MER-50: event decoder, md:events stream entries and the program-log cursor.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { utils } from "@coral-xyz/anchor";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EVENT_KINDS, fromFields, STREAM_KEY } from "../../shared/src/events.js";
import { MemoryCursorStore } from "../src/cursor.js";
import { decodeTransaction, EVENT_IX_TAG_LE, RawTx } from "../src/decoder.js";
import { CURSOR, Indexer } from "../src/indexer.js";
import { K } from "../src/keys.js";
import { Projector } from "../src/projector.js";
import { EventStream } from "../src/stream.js";
import { allEvents, FakeChain, fixture, nameOf, quiet, tx } from "./helpers/fixture.js";
import { startTestRedis, TestRedis } from "./helpers/redis.js";

/** The recorded day, as `label: kinds` (the decoder's golden output). */
const EXPECTED: [string, string[]][] = [
  ["morning", Array(9).fill("MarketCreated")],
  ["alice mints 100", ["PairMinted"]],
  ["alice asks 20 @ 64", ["OrderPlaced"]],
  ["bob bids 50 @ 61", ["OrderPlaced"]],
  ["carol buy no market 10", ["PairMinted", "Fill"]],
  ["dave buy no limit 10 @ 65", ["PairMinted", "OrderPlaced"]],
  ["erin buys yes ioc 25 @ 65", ["Fill", "Fill"]],
  ["carol sell no 5", ["Fill", "PairMerged"]],
  ["alice merges 10", ["PairMerged"]],
  ["bob cancels his bid", ["OrderCancelled"]],
  ["dave buy no limit 3 @ 70", ["PairMinted", "OrderPlaced"]],
  ["dave cancels it", ["OrderCancelled", "PairMerged"]],
  ["frank buy no limit 2 @ 90", ["PairMinted", "OrderPlaced"]],
  ["alice withdraws", ["Withdrawn"]],
  ["pause", ["Paused"]],
  ["unpause", ["Unpaused"]],
  ["void 720", ["MarketVoided"]],
  ["record close", ["CloseRecorded"]],
  ["dispute", ["DisputeRaised"]],
  ["correct", ["DisputeResolved", "CloseFinalized"]],
  ["settle strikes", Array(8).fill("MarketSettled")],
  ["prune", ["OrderCancelled", "PairMerged"]],
  ["close books", [...Array(9).fill("BookClosed"), "FeesSwept"]], // sorted: market order follows the keys
  ["alice redeems", ["Redeemed"]],
];

function kindsByLabel() {
  const out = new Map<string, string[]>();
  for (const t of fixture.txs) {
    const kinds = decodeTransaction(t, "confirmed", quiet).map((e) => e.kind);
    out.set(t.label, [...(out.get(t.label) ?? []), ...kinds]);
  }
  return [...out].filter(([, k]) => k.length > 0).map(([l, k]) => [l, l === "close books" ? [...k].sort() : k] as [string, string[]]);
}

describe("decoder", () => {
  it("IDX-01 the recorded day decodes to the expected event list, covering every spec 4.6 kind", () => {
    expect(kindsByLabel()).toEqual(EXPECTED);
    const seen = new Set(allEvents().map((e) => e.kind));
    expect([...EVENT_KINDS].filter((k) => !seen.has(k))).toEqual([]);
  });

  it("the decoded day matches day.events.json (the PG Writer's input fixture)", () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), "fixtures/day.events.json");
    const got = allEvents();
    if (process.env.UPDATE_GOLDEN || !existsSync(file)) writeFileSync(file, JSON.stringify(got) + "\n");
    expect(got).toEqual(JSON.parse(readFileSync(file, "utf8")));
  });

  it("decodes payload fields exactly (Fill, OrderPlaced, Close*, Withdrawn)", () => {
    const [mint, fill] = decodeTransaction(tx("carol buy no market 10"), "confirmed", quiet);
    expect(mint!.payload).toMatchObject({ n: "10", via: "BUY_NO", seq: "5" });
    expect(nameOf(String(fill!.payload.maker))).toBe("bob");
    expect(nameOf(String(fill!.payload.taker))).toBe("carol");
    expect(fill!.payload).toMatchObject({ side: "ASK", price: 61, qty: "10", taker_fee: "61000", maker_order_id: "2", seq: "6" });
    expect(Object.keys(fill!.payload).sort()).toEqual(["maker", "maker_order_id", "market", "price", "qty", "seq", "side", "slot", "taker", "taker_fee"]);
    expect([fill!.ix, fill!.ev, fill!.n]).toEqual([0, 1, 2]);

    const [, placed] = decodeTransaction(tx("dave buy no limit 10 @ 65"), "confirmed", quiet);
    expect(placed!.payload).toMatchObject({ side: "ASK", price: 65, qty: "10", tif: "GTC", tag: "BUY_NO", order_id: "3" });

    const [rec] = decodeTransaction(tx("record close"), "confirmed", quiet);
    expect(rec!.payload).toMatchObject({ ticker: "META", date: 20261125, price: "68400000", expo: -5, override: false, seq: "0" });
    expect(rec!.payload.market).toBe(fixture.markets.tickerDay);
    const [res, fin] = decodeTransaction(tx("correct"), "confirmed", quiet);
    expect(res!.payload).toMatchObject({ result: "CORRECTED", old_price: "68400000", new_price: "68512000" });
    expect(fin!.payload).toMatchObject({ basis: "CORRECTED", price: "68512000" });
    const [dsp] = decodeTransaction(tx("dispute"), "confirmed", quiet);
    expect(dsp!.payload.evidence_hash).toBe("09".repeat(32));
    const [w] = decodeTransaction(tx("alice withdraws"), "confirmed", quiet);
    expect(w!.payload).toMatchObject({ usdc: "12800000", yes: "0" });
  });

  it("unknown event kinds are logged and skipped, never crash", () => {
    const t = structuredClone(tx("carol buy no market 10")) as RawTx;
    const prog = t.accountKeys.indexOf(fixture.programId);
    const bogus = Buffer.concat([EVENT_IX_TAG_LE, Buffer.alloc(8, 0xab), Buffer.alloc(16)]);
    t.innerInstructions[0]!.instructions.splice(1, 0, { programIdIndex: prog, data: utils.bytes.bs58.encode(bogus) });
    const warnings: unknown[] = [];
    const evs = decodeTransaction(t, "confirmed", { warn: (m, x) => warnings.push([m, x]) });
    expect(evs.map((e) => e.kind)).toEqual(["PairMinted", "Fill"]);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toMatch(/unknown event discriminator/);
  });

  it("a failed transaction emits nothing; other programs' inner instructions are ignored", () => {
    expect(decodeTransaction({ ...tx("alice mints 100"), err: { InstructionError: [0, { Custom: 1 }] } }, "confirmed", quiet)).toEqual([]);
    const t = structuredClone(tx("alice mints 100")) as RawTx;
    const prog = t.accountKeys.indexOf(fixture.programId);
    for (const g of t.innerInstructions) for (const i of g.instructions) if (i.programIdIndex === prog) i.programIdIndex = 0;
    expect(decodeTransaction(t, "confirmed", quiet)).toEqual([]);
  });
});

describe("stream and cursor", () => {
  let r: TestRedis | null;
  beforeAll(async () => {
    r = await startTestRedis();
  });
  afterAll(async () => r?.stop());
  beforeEach(async () => r?.flush());

  const setup = (stream?: EventStream) => {
    const redis = r!.client();
    const cursor = new MemoryCursorStore();
    const s = stream ?? new EventStream(redis);
    const idx = new Indexer({ redis, source: new FakeChain(), cursor, projector: new Projector(redis, { now: () => 0 }), stream: s, log: quiet });
    return { redis, cursor, idx };
  };

  it("appends one md:events entry per event with exact fields", async () => {
    if (!r) return;
    const { redis, idx } = setup();
    const t = tx("carol buy no market 10");
    expect(await idx.processTransaction(t, "confirmed")).toBe(2);
    const entries = await redis.xrange(STREAM_KEY, "-", "+");
    expect(entries).toHaveLength(2);
    const [, fields] = entries[1]!;
    expect(fields.filter((_, i) => i % 2 === 0)).toEqual(["sig", "ix", "ev", "n", "slot", "commitment", "kind", "payload", "block_time"]);
    const f = Object.fromEntries(fields.flatMap((v, i, a) => (i % 2 === 0 ? [[v, a[i + 1]!]] : [])));
    expect(f).toMatchObject({ sig: t.signature, ix: "0", ev: "1", n: "2", slot: String(t.slot), commitment: "confirmed", kind: "Fill", block_time: String(t.blockTime) });
    expect(JSON.parse(f.payload!)).toEqual(decodeTransaction(t, "confirmed", quiet)[1]!.payload);
    expect(fromFields(fields)).toMatchObject({ type: "event", kind: "Fill", ix: 0, ev: 1, n: 2 });
  });

  it("IDX-03 the same event delivered twice is appended once", async () => {
    if (!r) return;
    const { redis, idx } = setup();
    const t = tx("erin buys yes ioc 25 @ 65");
    expect(await idx.processTransaction(t, "confirmed")).toBe(2);
    expect(await idx.processTransaction(t, "confirmed")).toBe(0);
    expect(await redis.xlen(STREAM_KEY)).toBe(2);
  });

  it("the cursor and md:slot advance only after a successful append", async () => {
    if (!r) return;
    const failing = { append: async () => { throw new Error("redis down"); } } as unknown as EventStream;
    const { redis, cursor, idx } = setup(failing);
    const t = tx("alice mints 100");
    await expect(idx.processTransaction(t, "confirmed")).rejects.toThrow(/redis down/);
    expect(await cursor.get(CURSOR)).toBeNull();
    expect(await redis.get(K.slot)).toBeNull();

    const ok = setup();
    await ok.idx.processTransaction(t, "confirmed");
    expect(await ok.cursor.get(CURSOR)).toEqual({ lastSlot: t.slot, lastSignature: t.signature });
    expect(await ok.redis.get(K.slot)).toBe(String(t.slot));
    // An older slot never moves either back.
    await ok.idx.processTransaction(tx("morning"), "confirmed");
    expect((await ok.cursor.get(CURSOR))!.lastSlot).toBe(t.slot);
    expect(await ok.redis.get(K.slot)).toBe(String(t.slot));
  });

  it("IDX-10 a processed-only notification writes and publishes nothing", async () => {
    if (!r) return;
    const { redis, idx } = setup();
    const sub = r.client();
    const got: string[] = [];
    await sub.psubscribe("md:ch:*");
    sub.on("pmessage", (_p, ch) => got.push(ch));
    expect(await idx.processTransaction(tx("bob bids 50 @ 61"), "processed")).toBe(0);
    await new Promise((res) => setTimeout(res, 50));
    expect(got).toEqual([]);
    expect(await redis.keys("md:*")).toEqual([]);
    await idx.processTransaction(tx("bob bids 50 @ 61"), "confirmed");
    await new Promise((res) => setTimeout(res, 50));
    expect(got.length).toBeGreaterThan(0);
  });
});
