// MER-65: WS Gateway, fed by the real Indexer projector publishing into a test Redis.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signJwt } from "../../shared/src/auth.js";
import { K } from "../../shared/src/keys.js";
import { Gateway, GatewayOptions } from "../src/gateway.js";
import { Client, sleep } from "./helpers/client.js";
import { groupsOf, M680, projector, replay, U } from "./helpers/day.js";
import { startTestRedis, TestRedis } from "./helpers/redis.js";

const SECRET = "ws-secret";
const tok = (sub: string, ttl = 900) => signJwt({ sub, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttl }, SECRET);

describe("ws gateway", () => {
  let r: TestRedis | null;
  let redis: Redis;
  let gw: Gateway;
  let url: string;
  const clients: Client[] = [];
  beforeAll(async () => {
    r = await startTestRedis();
  });
  afterAll(async () => r?.stop());
  async function start(o: Partial<GatewayOptions> = {}) {
    gw = new Gateway({ redis, sub: r!.client(), jwtSecret: SECRET, ...o });
    url = `ws://127.0.0.1:${await gw.listen(0, "127.0.0.1")}/v1/ws`;
  }
  beforeEach(async () => {
    if (!r) return;
    await r.flush();
    redis = r.client();
    await start();
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await gw?.close();
  });
  async function client(): Promise<Client> {
    const c = new Client(url);
    clients.push(c);
    await c.open();
    return c;
  }
  const book = `book:${M680}`;

  it("WS-01 subscribe to book:{m} sends the snapshot first, then deltas whose seq chains from it", async () => {
    if (!r) return;
    await replay(redis, "alice asks 20 @ 64");
    const c = await client();
    c.send({ op: "subscribe", channels: [book] });
    const snap = await c.waitFor((m) => m.type === "book_snapshot");
    const stored = JSON.parse((await redis.get(K.snap(M680)))!);
    expect(snap).toMatchObject({ channel: book, seq: stored.seq, bids: stored.bids, asks: [[64, 20]] });
    expect(c.msgs.findIndex((m) => m.type === "book_snapshot")).toBeLessThan(c.msgs.findIndex((m) => m.type === "book_delta") >>> 0);
    // An order lands on chain: the Indexer projects and publishes, the client gets the delta.
    const p = projector(redis);
    for (const g of groupsOf("bob bids 50 @ 61")) await p.applyInstruction(g);
    for (const g of groupsOf("carol buy no market 10")) await p.applyInstruction(g);
    await c.waitFor((m) => m.type === "book_delta" && m.changes !== undefined && c.of("book_delta").length >= 2);
    const deltas = c.of("book_delta", book);
    expect(BigInt(deltas[0]!.seq!)).toBeGreaterThan(BigInt(snap.seq!));
    expect(deltas[0]!.prev_seq).toBe(snap.seq);
    expect(deltas[1]!.prev_seq).toBe(deltas[0]!.seq);
    expect(deltas[0]!.changes).toEqual([["B", 61, 50]]);
    expect(deltas[1]!.changes).toEqual([["B", 61, 40]]);
  });

  it("a delta with seq at or below the snapshot is not sent", async () => {
    if (!r) return;
    await replay(redis, "bob bids 50 @ 61");
    const c = await client();
    c.send({ op: "subscribe", channels: [book] });
    const snap = await c.waitFor((m) => m.type === "book_snapshot");
    await redis.publish(K.ch.book(M680), JSON.stringify({ type: "book_delta", seq: snap.seq, prev_seq: "1", changes: [["B", 61, 1]] }));
    await redis.publish(K.ch.book(M680), JSON.stringify({ type: "book_delta", seq: "2", prev_seq: "1", changes: [["B", 61, 1]] }));
    await sleep(100);
    expect(c.of("book_delta")).toEqual([]);
    expect(c.of("book_snapshot")).toHaveLength(1);
  });

  it("WS-02 a lost delta is detected by prev_seq and answered with a fresh snapshot that matches Redis; clients can also ask", async () => {
    if (!r) return;
    await replay(redis, "alice asks 20 @ 64");
    const c = await client();
    c.send({ op: "subscribe", channels: [book] });
    await c.waitFor((m) => m.type === "book_snapshot");
    // Apply two instructions but drop the first one's publish (as if pub/sub lost it).
    const p = projector(redis);
    let skipped = false;
    // The projector publishes inside its MULTI: drop the first book publish there.
    const realMulti = redis.multi.bind(redis);
    (redis as unknown as { multi: () => unknown }).multi = () => {
      const m = realMulti();
      const pub = m.publish.bind(m);
      (m as unknown as { publish: (ch: string, msg: string) => unknown }).publish = (ch: string, msg: string) => {
        if (!skipped && ch === K.ch.book(M680)) {
          skipped = true;
          return m;
        }
        return pub(ch, msg);
      };
      return m;
    };
    for (const g of groupsOf("bob bids 50 @ 61")) await p.applyInstruction(g);
    for (const g of groupsOf("carol buy no market 10")) await p.applyInstruction(g);
    (redis as unknown as { multi: typeof realMulti }).multi = realMulti;
    await c.waitFor((m) => m.type === "book_snapshot" && c.of("book_snapshot").length === 2);
    const fresh = c.of("book_snapshot")[1]!;
    const stored = JSON.parse((await redis.get(K.snap(M680)))!);
    expect(fresh).toMatchObject({ seq: stored.seq, bids: stored.bids, asks: stored.asks });
    expect(fresh.bids).toEqual([[61, 40]]);
    expect(c.of("book_delta")).toEqual([]); // the orphan delta was not forwarded
    expect(gw.stats.snapshots).toBe(2);
    c.send({ op: "snapshot", channel: book });
    await c.waitFor(() => c.of("book_snapshot").length === 3);
  });

  it("WS-03 user channel needs auth, and carries only the subject's own events", async () => {
    if (!r) return;
    const c = await client();
    c.send({ op: "subscribe", channels: ["user"] });
    expect(await c.waitFor((m) => m.type === "error")).toMatchObject({ code: "UNAUTHORIZED", channel: "user" });
    c.send({ op: "auth", token: tok(U.bob, -1) });
    await c.waitFor((m) => m.type === "error" && c.of("error").length === 2);
    await redis.set(K.bal(U.bob), "9000000");
    c.send({ op: "auth", token: tok(U.bob) });
    expect(await c.waitFor((m) => m.type === "auth_ok")).toMatchObject({ owner: U.bob });
    expect(await c.waitFor((m) => m.type === "balance")).toMatchObject({ channel: "user", usdc: "9000000" });
    c.send({ op: "subscribe", channels: ["user"] });
    await c.waitFor((m) => m.type === "subscribed");
    // Real fills: carol's Buy No hits bob's bid; bob gets his fill, order and position, never carol's.
    await replay(redis, "bob bids 50 @ 61");
    const p = projector(redis);
    for (const g of groupsOf("carol buy no market 10")) await p.applyInstruction(g);
    await c.waitFor((m) => m.type === "position");
    await sleep(50);
    const user = c.msgs.filter((m) => m.channel === "user" && ["fill", "order", "position"].includes(m.type));
    // bob's resting bid, then its partial fill: his order updates, his position, his fill (carol's are on her channel).
    expect(user.map((m) => m.type)).toEqual(["order", "position", "fill", "order", "position"]);
    expect(user.filter((m) => m.type === "fill")).toEqual([expect.objectContaining({ intent: "BUY_YES", price: 61, qty: 10 })]);
    expect(user.at(-1)).toMatchObject({ yes: 10, ledger_yes: 10, avg_yes: 61 });
    await redis.publish(K.ch.user(U.carol), JSON.stringify({ type: "fill", qty: 1 }));
    await sleep(50);
    expect(c.msgs.filter((m) => m.channel === "user" && m.type === "fill")).toHaveLength(1);
  });

  it("WS-04 heartbeat every interval (15 s by default) and pong on ping", async () => {
    if (!r) return;
    expect(new Gateway({ redis, sub: redis, jwtSecret: SECRET })["o"].heartbeatMs).toBe(15_000);
    await gw.close();
    await start({ heartbeatMs: 100 });
    const c = await client();
    c.send({ op: "ping" });
    expect(await c.waitFor((m) => m.type === "pong")).toMatchObject({ serverTime: expect.any(String) });
    await sleep(350);
    const beats = c.of("heartbeat");
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats.length).toBeLessThanOrEqual(4);
    expect(beats[1]!.at - beats[0]!.at).toBeGreaterThan(70);
  });

  it("WS-05 market status reaches a subscriber within 150 ms of the Indexer publishing the settlement", async () => {
    if (!r) return;
    await replay(redis, "correct");
    const c = await client();
    c.send({ op: "subscribe", channels: [`market:${M680}`] });
    await c.waitFor((m) => m.type === "subscribed");
    const p = projector(redis);
    const t0 = performance.now();
    for (const g of groupsOf("settle strikes")) await p.applyInstruction(g);
    const m = await c.waitFor((x) => x.type === "market_status");
    expect(m).toMatchObject({ channel: `market:${M680}`, status: "SETTLED", outcome: "YES" });
    expect(m.settle_price).toBeDefined();
    expect(m.at - t0).toBeLessThan(150);
  });

  it("WS-06 underlying price is throttled to 4 Hz per ticker; the latest price is delivered", async () => {
    if (!r) return;
    const c = await client();
    c.send({ op: "subscribe", channels: ["px:META"] });
    await c.waitFor((m) => m.type === "subscribed");
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < 2000) {
      await redis.publish(K.ch.px("META"), JSON.stringify({ type: "underlying", price: `684.${String(i++).padStart(2, "0")}`, conf: "0.08", publish_time: 1 }));
      await sleep(50); // 20 Hz
    }
    await sleep(300);
    const px = c.of("underlying", "px:META");
    expect(i).toBeGreaterThan(30);
    expect(px.length).toBeLessThanOrEqual(9); // 4 Hz over 2 s, plus the trailing latest
    expect(px.length).toBeGreaterThanOrEqual(6);
    expect(px.at(-1)!.price).toBe(`684.${String(i - 1).padStart(2, "0")}`);
  });

  it("a slow consumer is disconnected instead of buffered forever", async () => {
    if (!r) return;
    await gw.close();
    await start({ maxBufferedBytes: 64 * 1024 });
    const slow = await client();
    const fast = await client();
    for (const c of [slow, fast]) c.send({ op: "subscribe", channels: [`trades:${M680}`] });
    await slow.waitFor((m) => m.type === "subscribed");
    await fast.waitFor((m) => m.type === "subscribed");
    (slow.ws as unknown as { _socket: { pause(): void } })._socket.pause(); // stops reading
    const big = JSON.stringify({ type: "trade", seq: "1", price: 61, qty: 1, pad: "x".repeat(32 * 1024) });
    for (let k = 0; k < 400; k++) await redis.publish(K.ch.trades(M680), big);
    await sleep(300);
    expect(gw.stats.dropped).toBe(1);
    expect(gw.connections).toBe(1);
    expect(fast.of("trade").length).toBe(400);
  });

  it("publish → client latency stays under 50 ms (p95) and the gateway never imports Postgres", async () => {
    if (!r) return;
    const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
    for (const f of readdirSync(src)) expect(readFileSync(join(src, f), "utf8")).not.toMatch(/from "pg"|require\("pg"\)|PG_URL|DATABASE_URL/);
    const c = await client();
    c.send({ op: "subscribe", channels: [`trades:${M680}`] });
    await c.waitFor((m) => m.type === "subscribed");
    const sent: number[] = [];
    for (let k = 0; k < 100; k++) {
      sent.push(performance.now());
      await redis.publish(K.ch.trades(M680), JSON.stringify({ type: "trade", seq: String(k), price: 61, qty: 1 }));
      await sleep(2);
    }
    await c.waitFor(() => c.of("trade").length === 100);
    const lat = c.of("trade").map((m) => m.at - sent[Number(m.seq)]!).sort((a, b) => a - b);
    expect(lat[94]!).toBeLessThan(50);
  });

  it("rejects unknown ops, channels and non-JSON with an error message, and keeps the connection", async () => {
    if (!r) return;
    const c = await client();
    c.ws.send("nope");
    c.send({ op: "dance" });
    c.send({ op: "subscribe", channels: ["book:not-a-key", "px:meta"] });
    c.send({ op: "snapshot", channel: book });
    await c.waitFor(() => c.of("error").length === 5);
    expect(c.of("error").every((m) => m.code === "VALIDATION")).toBe(true);
    c.send({ op: "ping" });
    await c.waitFor((m) => m.type === "pong");
  });
});
