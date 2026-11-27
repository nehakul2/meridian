// MER-60: reference, status and market read routes, served from the Indexer's Redis model.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { K } from "../../shared/src/keys.js";
import { dayPhase } from "../../shared/src/market.js";
import { checkUnits, Clock, makeApp } from "./helpers/app.js";
import { DATE, M680, M720, replay, T } from "./helpers/day.js";
import { startTestDb, TestDb } from "./helpers/pg.js";
import { startTestRedis, TestRedis } from "./helpers/redis.js";

describe("markets routes", () => {
  let r: TestRedis | null;
  let db: TestDb | null;
  let redis: Redis;
  const clock: Clock = { t: T.open + 3600 };
  let app: FastifyInstance;
  beforeAll(async () => {
    r = await startTestRedis();
    db = await startTestDb();
    if (db) {
      await db.pool.query(`INSERT INTO trading_calendar VALUES ('2026-11-25', '2026-11-25T14:30:00Z', '2026-11-25T21:00:00Z', false),
        ('2026-11-27', '2026-11-27T14:30:00Z', '2026-11-27T18:00:00Z', true)`);
    }
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
  const get = async (url: string) => {
    const res = await app.inject({ method: "GET", url });
    return { status: res.statusCode, body: res.json() };
  };

  it("TRD-16 / API-09 markets list and book: No ask = 100 − Yes bid, No bid = 100 − Yes ask, NO view inverts YES with the same seq", async () => {
    if (!r) return;
    await replay(redis, "bob bids 50 @ 61");
    const list = await get("/v1/tickers/META/markets?date=2026-11-25");
    expect(list.status).toBe(200);
    const m = list.body.markets.find((x: { marketId: string }) => x.marketId === M680);
    expect(m).toMatchObject({
      strike: "680.00", strikeCents: 68000, status: "TRADING", outcome: null, question: "Will META close at or above $680.00 today?",
      yes: { bid: 61, ask: 64, last: null }, no: { bid: 36, ask: 39 }, impliedProbability: 0.625, pairsOutstanding: 100,
    });
    expect(list.body.closeTime).toBe("2026-11-25T21:00:00Z");
    const yes = await get(`/v1/markets/${M680}/book?view=YES`);
    const no = await get(`/v1/markets/${M680}/book?view=NO`);
    expect(yes.body).toMatchObject({ view: "YES", bids: [[61, 50]], asks: [[64, 20]] });
    expect(no.body).toMatchObject({ view: "NO", bids: [[36, 20]], asks: [[39, 50]] });
    expect(no.body.seq).toBe(yes.body.seq);
    expect(no.body.seq).toBe(await redis.hget(K.bbo(M680), "seq"));
    // Matrix fixture levels: Yes bids [[61,1200]], asks [[64,500]] → NO asks [[39,1200]], bids [[36,500]].
    await redis.set(K.snap(M680), JSON.stringify({ seq: "9", bids: [[61, 1200]], asks: [[64, 500]] }));
    expect((await get(`/v1/markets/${M680}/book?view=NO`)).body).toMatchObject({ seq: "9", asks: [[39, 1200]], bids: [[36, 500]] });
    expect((await get(`/v1/markets/${M680}/book?view=MAYBE`)).body.error.code).toBe("VALIDATION");
  });

  it("API-05 unknown market and ticker → NOT_FOUND in the error envelope", async () => {
    if (!r) return;
    for (const url of ["/v1/markets/9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", "/v1/markets/nope/book", "/v1/markets/nope/trades", "/v1/tickers/ZZZZ/markets"]) {
      const res = await get(url);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: "NOT_FOUND", message: expect.any(String), details: {} } });
    }
  });

  it("HLT-04 / PSE-06 / CAL-08 status: phase from the server clock and ticker-day close, paused flag, serverTime", async () => {
    if (!r) return;
    await replay(redis, "bob bids 50 @ 61");
    clock.t = T.close + 10; // 16:00:10 ET
    const s = await get("/v1/status");
    expect(s.body).toMatchObject({ paused: false, tradingDate: "2026-11-25", phase: "HALTED", closeTime: "2026-11-25T21:00:00Z", closeTimeUnix: T.close, serverTime: new Date((T.close + 10) * 1000).toISOString() });
    expect((await get(`/v1/markets/${M680}`)).body.status).toBe("HALTED");
    clock.t = T.open + 60;
    expect((await get("/v1/status")).body.phase).toBe("TRADING");
    clock.t = T.mintOpen + 60;
    expect((await get("/v1/status")).body.phase).toBe("MINT_ONLY");
    expect((await get(`/v1/markets/${M680}`)).body.status).toBe("MINT_ONLY");
    await redis.hset(K.cfg, "paused", "1");
    expect((await get("/v1/status")).body.paused).toBe(true);

    // CAL-08 half day: the countdown target is the ticker-day's own close (13:00 ET), and the
    // server's clock is what the client counts from, whatever the client's clock says.
    await r.flush();
    const half = T.close - 3 * 3600;
    await replay(redis, "bob bids 50 @ 61", { closeTime: half });
    clock.t = half - 420;
    const h = await get("/v1/status");
    expect(h.body).toMatchObject({ closeTime: "2026-11-25T18:00:00Z", closeTimeUnix: half, phase: "TRADING" });
    expect(h.body.closeTimeUnix - Date.parse(h.body.serverTime) / 1000).toBe(420);
  });

  it("phase is computed for each time of day and settlement state", () => {
    const t = { mintOpenTime: 100, openTime: 200, closeTime: 300 };
    expect(dayPhase(50, t, [], false, true)).toBe("PRE_OPEN");
    expect(dayPhase(150, t, [], false, true)).toBe("MINT_ONLY");
    expect(dayPhase(250, t, ["OPEN"], false, true)).toBe("TRADING");
    expect(dayPhase(300, t, ["OPEN", "OPEN"], false, true)).toBe("HALTED");
    expect(dayPhase(400, t, ["PROVISIONAL", "OPEN"], false, true)).toBe("SETTLING");
    expect(dayPhase(400, t, ["PROVISIONAL", "PROVISIONAL"], false, true)).toBe("PROVISIONAL");
    expect(dayPhase(400, t, ["PROVISIONAL", "DISPUTED"], false, true)).toBe("DISPUTED");
    expect(dayPhase(400, t, ["FINAL", "FINAL"], false, true)).toBe("SETTLING");
    expect(dayPhase(400, t, ["FINAL", "FINAL"], true, true)).toBe("SETTLED");
    expect(dayPhase(400, null, [], false, true)).toBe("PRE_OPEN");
    expect(dayPhase(400, null, [], false, false)).toBe("CLOSED_DAY");
  });

  it("API-08 settlements match the recorded chain state: close, publish time, recordedBy and each strike's outcome", async () => {
    if (!r) return;
    await replay(redis);
    clock.t = T.close + 3 * 3600;
    const s = await get("/v1/settlements?date=2026-11-25");
    expect(s.status).toBe(200);
    const meta = s.body.tickers.find((x: { symbol: string }) => x.symbol === "META");
    const td = await redis.hgetall(K.tday("META", DATE));
    expect(meta).toMatchObject({
      status: "FINAL", closePrice: "685.12", closePriceRaw: td.close_price_raw, expo: Number(td.expo), recordedBy: "SETTLER",
      publishTime: new Date(Number(td.publish_time) * 1000).toISOString().replace(".000Z", "Z"), finalAtIsEstimate: false,
    });
    expect(meta.dispute).toMatchObject({ result: "CORRECTED", originalPriceRaw: "68400000" });
    const byId = Object.fromEntries(meta.markets.map((m: { marketId: string }) => [m.marketId, m]));
    expect(byId[M680]).toMatchObject({ strike: "680.00", outcome: "YES", provisional: false, status: "SETTLED" });
    expect(byId[M720]).toMatchObject({ outcome: "VOID", status: "VOID" });
    for (const m of meta.markets) {
      const h = await redis.hgetall(K.mkt(m.marketId));
      expect(m.outcome).toBe(h.outcome || null);
    }
  });

  it("settlements show a provisional outcome from the recorded close before strikes settle (D8)", async () => {
    if (!r) return;
    await replay(redis, "record close");
    clock.t = T.close + 400;
    const meta = (await get("/v1/settlements?date=2026-11-25")).body.tickers[0];
    expect(meta).toMatchObject({ status: "PROVISIONAL", closePrice: "684", finalAtIsEstimate: true });
    expect(meta.markets.find((m: { marketId: string }) => m.marketId === M680)).toMatchObject({ outcome: "YES", provisional: true, status: "TRADING" });
    expect((await get("/v1/status")).body.phase).toBe("PROVISIONAL");
    const one = (await get(`/v1/markets/${M680}`)).body;
    expect(one).toMatchObject({ status: "HALTED", outcome: "YES", outcomeProvisional: true });
  });

  it("trades come newest first from Redis; tickers show live underlying and active markets", async () => {
    if (!r) return;
    await replay(redis, "carol sell no 5");
    const t = await get(`/v1/markets/${M680}/trades?limit=2`);
    expect(t.body.data).toHaveLength(2);
    expect(Number(t.body.data[0].seq)).toBeGreaterThan(Number(t.body.data[1].seq));
    expect(t.body.data[0]).toMatchObject({ priceCents: 65, noPriceCents: 35, qty: 5, takerSide: "BID" });
    const older = await get(`/v1/markets/${M680}/trades?before=${t.body.data[1].seq}`);
    expect(older.body.data.every((x: { seq: string }) => Number(x.seq) < Number(t.body.data[1].seq))).toBe(true);
    await redis.hset(K.px("META"), { price: "684.21", conf: "0.08", publish_time: String(clock.t - 1) });
    const tk = await get("/v1/tickers");
    expect(tk.body.data.find((x: { symbol: string }) => x.symbol === "META")).toMatchObject({ underlying: { price: "684.21", conf: "0.08" }, tickerDayStatus: "OPEN" });
    expect(tk.body.data.find((x: { symbol: string }) => x.symbol === "META").activeMarkets).toBeGreaterThan(0);
  });

  it("calendar, candles and disputes are read from Postgres", async () => {
    if (!r || !db) return;
    await replay(redis, "carol sell no 5");
    const cal = await get("/v1/calendar?from=2026-11-24&to=2026-11-30");
    expect(cal.body.data).toEqual([
      { tradingDate: "2026-11-25", openTime: "2026-11-25T14:30:00.000Z", closeTime: "2026-11-25T21:00:00.000Z", closeTimeUnix: T.close, halfDay: false },
      { tradingDate: "2026-11-27", openTime: "2026-11-27T14:30:00.000Z", closeTime: "2026-11-27T18:00:00.000Z", closeTimeUnix: T.close + 86_400 * 2 - 3 * 3600, halfDay: true },
    ]);
    await db.pool.query(`INSERT INTO ticker_days (pda, symbol, trading_date, close_time, status) VALUES ('td', 'META', '2026-11-25', '2026-11-25T21:00:00Z', 'DISPUTED')`);
    await db.pool.query(`INSERT INTO markets (pda, ticker_day_pda, symbol, trading_date, strike_cents, yes_mint, no_mint, vault, status, created_by, created_slot)
      VALUES ($1, 'td', 'META', '2026-11-25', 68000, 'y', 'n', 'v', 'TRADING', 'AUTO', 1)`, [M680]);
    await db.pool.query(`INSERT INTO candles_1m VALUES ($1, '2026-11-25T15:46:00Z', 61, 64, 61, 64, 30), ($1, '2026-11-25T15:47:00Z', 65, 65, 65, 65, 10)`, [M680]);
    const c = await get(`/v1/markets/${M680}/candles?interval=5m&from=2026-11-25T15:00:00Z&to=2026-11-25T16:00:00Z`);
    expect(c.body.data).toEqual([{ time: "2026-11-25T15:45:00.000Z", o: 61, h: 65, l: 61, c: 65, volume: 40 }]);
    expect((await get(`/v1/markets/${M680}/candles?interval=7m`)).body.error.code).toBe("VALIDATION");
    await db.pool.query(`INSERT INTO disputes (ticker_day_pda, raised_by, bond_micro, evidence_hash, raised_at, old_price_raw, raised_sig)
      VALUES ('td', 'eve', 100000000, 'ab', '2026-11-25T21:07:00Z', 68400000, 'sig')`);
    const d = await get("/v1/disputes?date=2026-11-25");
    expect(d.body.data).toEqual([expect.objectContaining({ symbol: "META", status: "OPEN", bond: "100000000", oldPriceRaw: "68400000", tickerDayStatus: "DISPUTED" })]);
  });

  it("API-11 rate limit per IP and route: 429 RATE_LIMITED, counter resets in the next window", async () => {
    if (!r) return;
    await app.close();
    app = await makeApp(redis, null, clock, { rateLimit: { perSecond: 5, perMinute: 1000 } });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await app.inject({ method: "GET", url: "/v1/status" })).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    const res = await app.inject({ method: "GET", url: "/v1/status" });
    expect(res.json().error.code).toBe("RATE_LIMITED");
    expect(res.headers["retry-after"]).toBe("1");
    expect((await app.inject({ method: "GET", url: "/v1/tickers" })).statusCode).toBe(200); // other route, own counter
    clock.t += 1;
    expect((await app.inject({ method: "GET", url: "/v1/status" })).statusCode).toBe(200);
    expect((await redis.keys("md:rl:*")).length).toBeGreaterThan(0);
  });

  it("API-10 / API-13 every GET route answers from Redis and PG with no RPC client; money is integer strings, prices integer cents", async () => {
    if (!r) return;
    // No source file can construct an RPC client: the API has no RPC URL at all.
    const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
    const files = readdirSync(src, { recursive: true }).filter((f) => String(f).endsWith(".ts"));
    for (const f of files) {
      const s = readFileSync(join(src, String(f)), "utf8");
      expect(s, String(f)).not.toMatch(/new Connection\(|\bConnection\b.*from "@solana\/web3\.js"|RPC_URL/);
    }
    await replay(redis, "carol sell no 5");
    const urls = [
      "/v1/health", "/v1/status", "/v1/tickers", "/v1/tickers/META/markets?date=2026-11-25", `/v1/markets/${M680}`,
      `/v1/markets/${M680}/book?view=NO`, `/v1/markets/${M680}/trades`, "/v1/settlements?date=2026-11-25",
      ...(db ? ["/v1/calendar", `/v1/markets/${M680}/candles`, "/v1/disputes?date=2026-11-25"] : []),
    ];
    for (const u of urls) {
      const res = await get(u);
      expect(res.status, u).toBe(200);
      expect(checkUnits(res.body), u).toEqual([]);
    }
  });

  it("p99 of the hot reads stays under 20 ms on the fixture", async () => {
    if (!r) return;
    await replay(redis, "carol sell no 5");
    const urls = ["/v1/tickers/META/markets?date=2026-11-25", `/v1/markets/${M680}`, `/v1/markets/${M680}/book?view=NO`, "/v1/status"];
    for (const u of urls) await get(u); // warm up
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      await get(urls[i % urls.length]!);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.99)]!).toBeLessThan(20);
  });
});
