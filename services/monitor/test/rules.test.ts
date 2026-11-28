/**
 * MER-81: Monitor rules. Each rule fires at its threshold and not a second before; alerts are
 * stored once per (code, symbol, date) and PAGE goes to the on-call channel; a clean day raises
 * nothing. Matrix: SJ-05, MKT-06. The last block runs the collector and the Postgres alert store
 * against the real schema (db/migrations).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { etToUnix } from "../../automation/src/time.js";
import { AlertRecord, AlertRouter, MemoryAlertStore, OnCall, PgAlertStore, silentLogger, WebhookOnCall } from "../src/alerts.js";
import { Collector } from "../src/collect.js";
import { parseGateways } from "../src/main.js";
import { AlertCandidate, evaluate, MarketRow, Snapshot, straddles, TickerDayRow } from "../src/rules.js";
import { startTestDb, TestDb } from "./helpers/pg.js";

const MAG7 = ["AAPL", "AMZN", "GOOGL", "META", "MSFT", "NVDA", "TSLA"];
const DATE = "2026-11-25";
const CLOSE = etToUnix(DATE, 16, 0);
const at = (hh: number, mm: number, ss = 0) => etToUnix(DATE, hh, mm, ss);
const PRICE = 68_512_000n; // $685.12 at expo -5
const CONF = 50_000n; // $0.50

function day(over: Partial<TickerDayRow> = {}, symbol = "AAPL"): TickerDayRow {
  return { symbol, status: "OPEN", closeTime: CLOSE, recordedAt: null, finalizedAt: null, priceRaw: null, expo: null, conf: null, ...over };
}
const markets = (symbol: string, status: MarketRow["status"] = "TRADING", strikes = [67_000n, 68_000n, 69_000n]): MarketRow[] =>
  strikes.map((strikeCents) => ({ symbol, strikeCents, status }));

/** A healthy day at time `now`: every ticker created; recorded at close + 1 min and final 20 min later when past those. */
function healthy(now: number, o: Partial<Snapshot> = {}): Snapshot {
  const recorded = now >= CLOSE + 60;
  const final = now >= CLOSE + 60 + 1200;
  const settled = now >= CLOSE + 60 + 1200 + 120;
  return {
    now, date: DATE, calendar: { closeTime: CLOSE }, tickers: MAG7, skipped: [],
    tickerDays: MAG7.map((s) => day({
      status: final ? "FINAL" : recorded ? "PROVISIONAL" : "OPEN",
      recordedAt: recorded ? CLOSE + 60 : null, finalizedAt: final ? CLOSE + 1260 : null,
      priceRaw: recorded ? PRICE : null, expo: recorded ? -5 : null, conf: recorded ? CONF : null,
    }, s)),
    markets: MAG7.flatMap((s) => markets(s, settled ? "SETTLED" : now >= CLOSE ? "HALTED" : "TRADING")),
    settleReason: {}, indexer: { processedSlot: 1000, newestProgramTx: { slot: 1000, blockTime: now - 1 } },
    gateways: [{ id: "ws-1", ok: true, errors: 3, prevErrors: 3 }], reconcile: { invariantBreaks: 0, detail: "{}" },
    ...o,
  };
}
const codes = (xs: AlertCandidate[]) => xs.map((x) => `${x.severity} ${x.code}${x.symbol ? ` ${x.symbol}` : ""}`);

describe("clean day", () => {
  it("raises nothing at any check from 08:00 to 20:30 ET", () => {
    for (let t = at(8, 0); t <= at(20, 30); t += 60) expect(codes(evaluate(healthy(t))), new Date(t * 1000).toISOString()).toEqual([]);
  });

  it("raises nothing on a holiday with no markets", () => {
    expect(evaluate(healthy(at(9, 0), { calendar: null, tickerDays: [], markets: [] }))).toEqual([]);
  });
});

describe("morning (MKT-06)", () => {
  const tslaMissing = (t: number) => healthy(t, {
    tickerDays: healthy(t).tickerDays.filter((d) => d.symbol !== "TSLA"),
    markets: healthy(t).markets.filter((m) => m.symbol !== "TSLA"),
  });
  it("pages MORNING_INCOMPLETE at 08:45 ET naming the ticker, and not at 08:44:59", () => {
    expect(evaluate(tslaMissing(at(8, 44, 59)))).toEqual([]);
    const a = evaluate(tslaMissing(at(8, 45)));
    expect(codes(a)).toEqual(["PAGE MORNING_INCOMPLETE TSLA"]);
    expect(a[0]!.message).toContain("TSLA");
    expect(a[0]!.date).toBe(DATE);
  });
  it("a ticker-day without strike markets is incomplete too", () => {
    const s = healthy(at(8, 50), { markets: healthy(at(8, 50)).markets.filter((m) => m.symbol !== "NVDA") });
    expect(codes(evaluate(s))).toEqual(["PAGE MORNING_INCOMPLETE NVDA"]);
  });
  it("a ticker the morning job skipped (corporate action) is not incomplete", () => {
    expect(evaluate({ ...tslaMissing(at(9, 0)), skipped: ["TSLA"] })).toEqual([]);
  });
});

describe("settlement (SJ-05)", () => {
  const unrecorded = (t: number, reason?: string) => healthy(t, {
    tickerDays: healthy(t).tickerDays.map((d) => (d.symbol === "META" ? day({}, "META") : d)),
    settleReason: reason ? { META: reason } : {},
  });
  it("WARN SETTLE_SLA_AT_RISK at close + 5 min, not at + 4:59", () => {
    expect(evaluate(unrecorded(CLOSE + 299))).toEqual([]);
    expect(codes(evaluate(unrecorded(CLOSE + 300, "Massive has no official close yet")))).toEqual(["WARN SETTLE_SLA_AT_RISK META"]);
  });
  it("PAGE SETTLE_SLA_BREACHED at close + 15 min with the ticker and the settler's reason", () => {
    expect(codes(evaluate(unrecorded(CLOSE + 899)))).toEqual(["WARN SETTLE_SLA_AT_RISK META"]);
    const a = evaluate(unrecorded(CLOSE + 900, "Pyth conf 14 bps > 10 bps"));
    expect(codes(a)).toEqual(["PAGE SETTLE_SLA_BREACHED META"]);
    expect(a[0]!.message).toMatch(/META close not recorded 15 min after close: Pyth conf 14 bps > 10 bps/);
  });
  it("names a missing SETTLE run when the settler never ran", () => {
    expect(evaluate(unrecorded(CLOSE + 900))[0]!.message).toContain("no SETTLE run recorded");
  });
  it("a half-day close (13:00) is measured from its own close_time", () => {
    const close = etToUnix("2026-11-27", 13, 0);
    const s: Snapshot = { ...healthy(close), date: "2026-11-27", calendar: { closeTime: close }, tickerDays: [day({ closeTime: close })], markets: markets("AAPL", "HALTED"), tickers: ["AAPL"] };
    expect(codes(evaluate({ ...s, now: close + 300 }))).toEqual(["WARN SETTLE_SLA_AT_RISK AAPL"]);
  });
});

describe("strikes after the close is final", () => {
  const FINAL = CLOSE + 1260;
  const stuck = (t: number, strikes = [67_000n, 68_000n, 69_000n]) => healthy(t, {
    markets: healthy(t).markets.map((m) => (m.symbol === "AMZN" && strikes.includes(m.strikeCents) ? { ...m, status: "HALTED" } : m)),
  });
  it("PAGE STRIKES_UNSETTLED at final + 10 min, not before", () => {
    expect(evaluate(stuck(FINAL + 599, [67_000n]))).toEqual([]);
    const a = evaluate(stuck(FINAL + 600, [67_000n]));
    expect(codes(a)).toEqual(["PAGE STRIKES_UNSETTLED AMZN"]);
    expect(a[0]!.message).toContain("$670.00");
  });
  it("PAGE STRIKE_REFUSED for a strike inside the confidence band, without waiting", () => {
    // AMZN closes at $685.12 +/- $0.50; a $685.00 strike straddles, $680.00 does not.
    const s = healthy(FINAL + 1, {
      markets: [...healthy(FINAL + 1).markets.filter((m) => m.symbol !== "AMZN"), ...markets("AMZN", "HALTED", [68_500n]), ...markets("AMZN", "SETTLED", [68_000n])],
    });
    const a = evaluate(s);
    expect(codes(a)).toEqual(["PAGE STRIKE_REFUSED AMZN"]);
    expect(a[0]!.message).toContain("$685.00");
    expect(a[0]!.message).toContain("admin_settle_market");
  });
  it("straddle is checked at full precision", () => {
    expect(straddles(68_500n, PRICE, -5, CONF)).toBe(true); // |685.12 - 685.00| = 0.12 < 0.50
    expect(straddles(68_462n, PRICE, -5, CONF)).toBe(false); // |0.50| is not < 0.50
    expect(straddles(68_463n, PRICE, -5, CONF)).toBe(true);
    expect(straddles(68_512n, 68_512n, -2, 0n)).toBe(false); // exactly at the strike with zero conf
  });
});

describe("indexer, gateways, reconcile", () => {
  const t = at(11, 0);
  it("WARN INDEXER_LAG when the newest program tx is not indexed after 5 s", () => {
    const lag = (s: number, processed = 990) => healthy(t, { indexer: { processedSlot: processed, newestProgramTx: { slot: 1000, blockTime: t - s } } });
    expect(evaluate(lag(5))).toEqual([]);
    expect(codes(evaluate(lag(6)))).toEqual(["WARN INDEXER_LAG"]);
    expect(evaluate(lag(60, 1000))).toEqual([]); // caught up: a quiet chain is not lag
    expect(codes(evaluate(healthy(t, { indexer: { processedSlot: null, newestProgramTx: { slot: 5, blockTime: t - 30 } } })))).toEqual(["WARN INDEXER_LAG"]);
  });
  it("WARN WS_GATEWAY_DOWN when /healthz fails, WS_GATEWAY_ERRORS when errors jump by more than 10", () => {
    expect(codes(evaluate(healthy(t, { gateways: [{ id: "ws-2", ok: false, detail: "ECONNREFUSED" }] })))).toEqual(["WARN WS_GATEWAY_DOWN ws-2"]);
    expect(evaluate(healthy(t, { gateways: [{ id: "ws-1", ok: true, errors: 13, prevErrors: 3 }] }))).toEqual([]);
    expect(codes(evaluate(healthy(t, { gateways: [{ id: "ws-1", ok: true, errors: 14, prevErrors: 3 }] })))).toEqual(["WARN WS_GATEWAY_ERRORS ws-1"]);
  });
  it("PAGE INVARIANT_BREAK when the reconcile report has a break", () => {
    const a = evaluate(healthy(at(20, 5), { reconcile: { invariantBreaks: 1, detail: "vault < accounted on AAPL 680" } }));
    expect(codes(a)).toEqual(["PAGE INVARIANT_BREAK"]);
    expect(a[0]!.message).toContain("vault < accounted");
  });
});

class RecordingOnCall implements OnCall {
  readonly paged: AlertRecord[] = [];
  failNext = 0;
  async page(a: AlertRecord) {
    if (this.failNext-- > 0) throw new Error("webhook down");
    this.paged.push(a);
  }
}

describe("dedupe and routing", () => {
  const page: AlertCandidate = { severity: "PAGE", code: "SETTLE_SLA_BREACHED", symbol: "META", date: DATE, message: "m" };
  const warn: AlertCandidate = { severity: "WARN", code: "INDEXER_LAG", symbol: null, date: DATE, message: "lag" };

  it("stores one alert per open (code, symbol, date) however often the rule fires", async () => {
    const store = new MemoryAlertStore();
    const router = new AlertRouter(store, new RecordingOnCall(), silentLogger);
    for (let i = 0; i < 5; i++) await router.route([page, warn, { ...page, message: `m${i}` }]);
    expect(store.rows.map((r) => r.code)).toEqual(["SETTLE_SLA_BREACHED", "INDEXER_LAG"]);
    // A different ticker or date is a different alert.
    await router.route([{ ...page, symbol: "TSLA" }, { ...page, date: "2026-11-24" }]);
    expect(store.rows).toHaveLength(4);
    // Once acked, the next occurrence is a new alert.
    store.ack(1);
    await router.route([page]);
    expect(store.rows).toHaveLength(5);
  });

  it("routes PAGE to the on-call channel once, never WARN, and retries a failed page", async () => {
    const oncall = new RecordingOnCall();
    const router = new AlertRouter(new MemoryAlertStore(), oncall, silentLogger);
    oncall.failNext = 1;
    await router.route([page, warn]);
    expect(oncall.paged).toHaveLength(0);
    await router.route([page, warn]);
    expect(oncall.paged.map((a) => a.code)).toEqual(["SETTLE_SLA_BREACHED"]);
    await router.route([page, warn]);
    expect(oncall.paged).toHaveLength(1);
  });

  it("the webhook posts a Slack-style text naming code, ticker and date", async () => {
    const calls: { url: string; body: string }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response("ok");
    }) as unknown as typeof fetch;
    await new WebhookOnCall("https://hooks.example/oncall", f).page({ ...page, id: 1, createdAt: 0, ackedAt: null });
    expect(calls[0]!.url).toBe("https://hooks.example/oncall");
    expect(JSON.parse(calls[0]!.body).text).toMatch(/PAGE SETTLE_SLA_BREACHED META 2026-11-25: m/);
  });

  it("parses WS_HEALTH_URLS", () => {
    expect(parseGateways("ws-a=http://a:1/healthz, http://b:2/healthz")).toEqual([
      { id: "ws-a", url: "http://a:1/healthz" }, { id: "ws-2", url: "http://b:2/healthz" },
    ]);
  });
});

const here = dirname(fileURLToPath(import.meta.url));
let db: TestDb | null = null;
let pool: pg.Pool;

describe("collector and Postgres store on the real schema", () => {
  beforeAll(async () => {
    db = startTestDb();
    if (!db) return;
    pool = new pg.Pool({ connectionString: db.url });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    const dir = join(here, "../../../db/migrations");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await pool.query(readFileSync(join(dir, f), "utf8"));
    for (const [i, s] of MAG7.entries()) await pool.query("INSERT INTO tickers (symbol, pyth_feed_id) VALUES ($1, $2)", [s, Buffer.alloc(32, i + 1)]);
    await pool.query("INSERT INTO trading_calendar VALUES ($1, to_timestamp($2), to_timestamp($3), false)", [DATE, at(9, 30), CLOSE]);
    for (const s of MAG7) {
      if (s === "TSLA") continue; // never created
      const recorded = s !== "META"; // META's close is never recorded
      await pool.query(
        `INSERT INTO ticker_days (pda, symbol, trading_date, close_time, status, recorded_at, finalized_at, close_price_raw, close_expo, close_conf)
         VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7, $8, $9, $10)`,
        [`td-${s}`, s, DATE, CLOSE, recorded ? "FINAL" : "OPEN", recorded ? new Date((CLOSE + 60) * 1000) : null,
          recorded ? new Date((CLOSE + 1260) * 1000) : null, recorded ? PRICE.toString() : null, recorded ? -5 : null, recorded ? CONF.toString() : null],
      );
      for (const strike of [68_000n, 68_500n]) {
        const id = `${s}-${strike}`;
        // 680 settled everywhere; 685 straddles the AMZN close and is still halted.
        const status = strike === 68_000n || s !== "AMZN" ? (recorded ? "SETTLED" : "HALTED") : "HALTED";
        await pool.query(
          `INSERT INTO markets (pda, ticker_day_pda, symbol, trading_date, strike_cents, yes_mint, no_mint, vault, status, created_by, created_slot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'AUTO', 1)`,
          [id, `td-${s}`, s, DATE, strike.toString(), `y-${id}`, `n-${id}`, `v-${id}`, status],
        );
      }
    }
    await pool.query(
      `INSERT INTO job_runs (job, trading_date, symbol, attempt, status, detail, started_at) VALUES
        ('SETTLE', $1, 'META', 1, 'RETRY', '{"detail":"older reason"}', to_timestamp($2)),
        ('SETTLE', $1, 'META', 2, 'RETRY', '{"result":"RETRY","detail":"Databento and Massive disagree"}', to_timestamp($3))`,
      [DATE, CLOSE + 300, CLOSE + 330],
    );
    await pool.query("INSERT INTO reconcile_reports (trading_date, missing_count, mismatch_count, invariant_breaks, diff) VALUES ($1, 0, 0, 1, '{\"AAPL\":\"vault < accounted\"}')", [DATE]);
  });
  afterAll(async () => {
    await pool?.end();
    db?.stop();
  });

  it("collects the day from Postgres, evaluates and stores each alert once", async () => {
    if (!db) return;
    const gw = (async () => new Response(JSON.stringify({ ok: true, errors: 0 }))) as unknown as typeof fetch;
    const c = new Collector({ pool, redis: null, gateways: [{ id: "ws-1", url: "http://ws/healthz" }], fetchFn: gw, newestProgramTx: async () => null });
    const now = CLOSE + 1260 + 600;
    const snap = await c.snapshot(now, DATE);
    expect(snap.calendar).toEqual({ closeTime: CLOSE });
    expect(snap.settleReason).toEqual({ META: "Databento and Massive disagree" });
    const alerts = evaluate(snap);
    expect(codes(alerts).sort()).toEqual([
      "PAGE INVARIANT_BREAK", "PAGE MORNING_INCOMPLETE TSLA", "PAGE SETTLE_SLA_BREACHED META", "PAGE STRIKE_REFUSED AMZN",
    ]);

    const oncall = new RecordingOnCall();
    const router = new AlertRouter(new PgAlertStore(pool), oncall, silentLogger);
    await router.route(alerts);
    await router.route(evaluate(await c.snapshot(now + 15, DATE)));
    const rows = (await pool.query("SELECT severity, code, symbol, trading_date::text AS d FROM alerts ORDER BY id")).rows;
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.d === DATE && r.severity === "PAGE")).toBe(true);
    expect(oncall.paged).toHaveLength(4);

    // Automation already raised the WARN for this code: the Monitor does not duplicate it.
    await pool.query("INSERT INTO alerts (severity, code, symbol, trading_date, message) VALUES ('WARN', 'SETTLE_SLA_AT_RISK', 'MSFT', $1, 'from automation')", [DATE]);
    expect(await new PgAlertStore(pool).insertIfNew({ severity: "WARN", code: "SETTLE_SLA_AT_RISK", symbol: "MSFT", date: DATE, message: "x" })).toBeNull();
  });
});
