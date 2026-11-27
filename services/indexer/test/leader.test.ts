// MER-52: leader lease on md:lock:indexer, failover with backfill, fencing of an old leader.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { STREAM_KEY } from "../../shared/src/events.js";
import { MemoryCursorStore } from "../src/cursor.js";
import { Indexer } from "../src/indexer.js";
import { K } from "../../shared/src/keys.js";
import { LeaderLease } from "../src/leader.js";
import { IndexerNode } from "../src/node.js";
import { Projector } from "../src/projector.js";
import { EventStream, NotLeaderError } from "../src/stream.js";
import { allEvents, FakeChain, fixture, quiet } from "./helpers/fixture.js";
import { startTestRedis, TestRedis } from "./helpers/redis.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(f: () => Promise<boolean> | boolean, ms: number): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await f()) return Date.now() - t0;
    await sleep(20);
  }
  throw new Error(`condition not met within ${ms} ms`);
}

describe("leader", () => {
  let r: TestRedis | null;
  beforeAll(async () => {
    r = await startTestRedis();
  });
  afterAll(async () => r?.stop());
  beforeEach(async () => r?.flush());

  /** A node with its own connections, sharing the cursor store (Postgres in production). */
  function node(name: string, chain: FakeChain, cursor: MemoryCursorStore, ttlMs = 1000, renewMs = 300) {
    const redis = r!.client();
    const lease = new LeaderLease(r!.client(), { id: name, ttlMs, renewMs });
    const projector = new Projector(redis, { guard: lease, now: () => 1 });
    const stream = new EventStream(redis, lease.token);
    const indexer = new Indexer({ redis, source: chain, cursor, projector, stream, log: quiet, isLeader: () => lease.isLeader });
    return { lease, indexer, node: new IndexerNode(name, lease, indexer, chain, projector, { finalityEveryMs: 60_000, backfillPollMs: 60_000 }) };
  }

  it("defaults follow spec 3.4: 10 s lease renewed every 3 s", () => {
    if (!r) return;
    const l = new LeaderLease(r.client());
    expect([l.ttlMs, l.renewMs]).toEqual([10_000, 3_000]);
  });

  it("IDX-06 only one leader at a time", async () => {
    if (!r) return;
    const a = new LeaderLease(r.client(), { id: "a", ttlMs: 1000 });
    const b = new LeaderLease(r.client(), { id: "b", ttlMs: 1000 });
    expect(await a.tryAcquire()).toBe(true);
    expect(await b.tryAcquire()).toBe(false);
    expect(await a.renew()).toBe(true);
    expect(await b.renew()).toBe(false);
    expect(await r.client().get(K.lock)).toBe("a");
    expect(await r.client().pttl(K.lock)).toBeGreaterThan(900);
    await a.release();
    expect(await b.tryAcquire()).toBe(true);
    expect(await a.renew()).toBe(false);
  });

  it("IDX-06 standby takes over within the lease TTL, backfills the gap exactly once, and an old leader that wakes up cannot write", async () => {
    if (!r) return;
    const txs = fixture.txs;
    const half = txs.findIndex((t) => t.label === "carol sell no 5");
    const chain = new FakeChain(txs.slice(0, half));
    const cursor = new MemoryCursorStore();
    const A = node("A", chain, cursor);
    const B = node("B", chain, cursor);
    await A.node.start();
    expect(A.lease.isLeader).toBe(true);
    await B.node.start();
    expect(B.lease.isLeader).toBe(false);
    // A backfilled the first half on becoming leader; live notifications are processed too.
    await until(() => A.node.live, 2000);
    chain.land(txs[half]!);
    await until(async () => (await cursor.get("program_logs"))?.lastSignature === txs[half]!.signature, 2000);

    // A crashes (no lease release). While nobody leads, the rest of the day lands.
    A.node.freeze();
    const stoppedAt = Date.now();
    for (const t of txs.slice(half + 1)) chain.land(t);
    const took = await until(() => B.node.live, 3000);
    expect(Date.now() - stoppedAt).toBeLessThan(1000 + 300 + 500); // TTL + one renew period (+ scheduling)
    expect(took).toBeGreaterThan(0);
    expect(B.node.events).toEqual(["leader", "live"]);

    // Every event of the day is in the stream exactly once.
    const redis = r.client();
    const entries = await redis.xrange(STREAM_KEY, "-", "+");
    const keys = entries.map(([, f]) => `${f[1]}:${f[3]}:${f[5]}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(allEvents().length);
    expect(await redis.hget(K.mkt(fixture.markets.m680), "status")).toBe("SETTLED");

    // A wakes up still thinking it leads: the stream append and the projector refuse.
    A.node.wake();
    const extra = { ...txs.at(-1)!, signature: "replayed-by-stale-leader" };
    await expect(A.indexer.processTransaction(extra, "confirmed")).rejects.toBeInstanceOf(NotLeaderError);
    expect(await redis.xlen(STREAM_KEY)).toBe(entries.length);
    expect(await A.lease.renew()).toBe(false);
    expect(await redis.get(K.lock)).toBe("B");
    await B.node.stop();
    await A.node.stop();
  });
});
