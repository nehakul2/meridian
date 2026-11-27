// PgStore against a real Postgres: the spec 5 schema migrates, first-write-wins rows, alerts,
// job_runs, and the advisory lock that keeps two automation replicas apart (CON-07).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCalendarYear } from "../src/calendar.js";
import { migrate, PgStore } from "../src/store/pg.js";
import { DEFAULT_POLICY } from "../src/strikes.js";
import { etToUnix } from "../src/time.js";
import { startTestDb, TestDb } from "./helpers/pg.js";

const db = startTestDb();
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");

describe.skipIf(!db)("PgStore", () => {
  let pool: pg.Pool;
  let store: PgStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: (db as TestDb).url, max: 6 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    expect(await migrate(pool, MIGRATIONS)).toEqual(["0001_init.sql", "0002_automation.sql", "0003_api.sql"]);
    expect(await migrate(pool, MIGRATIONS)).toEqual([]); // idempotent
    store = new PgStore(pool);
    await pool.query("INSERT INTO tickers (symbol, pyth_feed_id, liquidity_tier_override) VALUES ('META', decode(repeat('06',32),'hex'), 'A'), ('AAPL', decode(repeat('01',32),'hex'), NULL)");
    await pool.query("INSERT INTO strike_policy DEFAULT VALUES");
  });

  afterAll(async () => {
    await pool?.end();
    db?.stop();
  });

  it("reads tickers and the default strike policy (spec 5 defaults = DEFAULT_POLICY)", async () => {
    const t = await store.enabledTickers();
    expect(t.map((x) => [x.symbol, x.pythFeedId.slice(0, 4), x.liquidityTierOverride])).toEqual([["AAPL", "0101", null], ["META", "0606", "A"]]);
    expect({ ...(await store.activePolicy()), id: 1 }).toEqual(DEFAULT_POLICY);
  });

  it("calendar rows round-trip in UTC", async () => {
    await store.upsertCalendar(buildCalendarYear(2026));
    const rows = await store.calendarRows();
    expect(rows).toHaveLength(251);
    const fri = rows.find((r) => r.tradingDate === "2026-11-27")!;
    expect([fri.isHalfDay, fri.closeTime]).toEqual([true, Date.parse("2026-11-27T18:00:00Z") / 1000]);
  });

  it("oracle_updates and official_closes are first-write-wins", async () => {
    const base = { symbol: "META", tradingDate: "2026-11-25", purpose: "SETTLE" as const, targetTime: 100, publishTime: 101, priceRaw: 68512000n, expo: -5, conf: 6851n, vaa: new Uint8Array([1, 2, 3]), fetchedAt: 200 };
    const a = await store.putOracleUpdate(base);
    const b = await store.putOracleUpdate({ ...base, priceRaw: 1n, vaa: new Uint8Array([9]) });
    expect(b).toEqual(a);
    expect([...b.vaa]).toEqual([1, 2, 3]);
    const c = { symbol: "META", tradingDate: "2026-11-25", priceCents: 68512n, massiveCents: 68512n, massiveAt: 300, databentoCents: 68512n, databentoAt: 301 };
    await store.putOfficialClose(c);
    await store.putOfficialClose({ ...c, priceCents: 1n, massiveCents: 1n, databentoCents: 1n });
    expect((await store.getOfficialClose("META", "2026-11-25"))!.priceCents).toBe(68512n);
    // The table refuses a row where the vendors disagree (never write from one vendor).
    await expect(store.putOfficialClose({ ...c, tradingDate: "2026-11-24", databentoCents: 68510n })).rejects.toThrow(/check/i);
    expect((await store.officialClosesBefore("META", "2026-11-26", 5)).map((x) => x.tradingDate)).toEqual(["2026-11-25"]);
  });

  it("strike_inputs is written once and reused", async () => {
    const row = {
      symbol: "META", tradingDate: "2026-11-25", prevCloseCents: 68000n, ivBps: 3500n, ivSource: "MASSIVE x", rv20Bps: 1621n,
      volUsedBps: 3500n, volBasis: "IV" as const, liquidityContracts5d: 0n, liquidityTier: "A" as const, move1dCents: 1499n,
      stepCents: 1000n, perSide: 4n, strikesCents: [64000n, 68000n, 72000n], policyId: 1, computedAt: 1000,
    };
    expect(await store.putStrikeInputs(row)).toEqual(row);
    expect((await store.putStrikeInputs({ ...row, strikesCents: [1n] })).strikesCents).toEqual(row.strikesCents);
  });

  it("job_runs count attempts per (job, date, symbol); alerts dedupe while open", async () => {
    const r1 = await store.startJobRun("SETTLE", "2026-11-25", "META");
    await store.finishJobRun(r1.id, "RETRY", { error: "x" });
    const r2 = await store.startJobRun("SETTLE", "2026-11-25", "META");
    await store.finishJobRun(r2.id, "OK", { n: 1n }, ["sig"]);
    const n = await store.startJobRun("SETTLE", "2026-11-25", null);
    expect([r1.attempt, r2.attempt, n.attempt]).toEqual([1, 2, 1]);
    const runs = await store.jobRuns("2026-11-25", "SETTLE");
    expect(runs.map((r) => r.status)).toEqual(["RETRY", "OK", "RUNNING"]);
    expect(runs[1]!.txSigs).toEqual(["sig"]);
    expect(runs[1]!.detail).toEqual({ n: "1" });
    const a = await store.raiseAlert({ severity: "PAGE", code: "SETTLE_FAILED", symbol: "META", tradingDate: "2026-11-25", message: "m" });
    const b = await store.raiseAlert({ severity: "PAGE", code: "SETTLE_FAILED", symbol: "META", tradingDate: "2026-11-25", message: "again" });
    expect(b.id).toBe(a.id);
    await pool.query("UPDATE alerts SET acked_at = now(), acked_by = 'neha' WHERE id = $1", [a.id]);
    const c = await store.raiseAlert({ severity: "PAGE", code: "SETTLE_FAILED", symbol: "META", tradingDate: "2026-11-25", message: "new" });
    expect(c.id).not.toBe(a.id);
  });

  it("CON-07 advisory lock: a second replica cannot take a held job lock", async () => {
    const other = new PgStore(pool);
    const release = await store.tryLock("automation:SETTLE:2026-11-25");
    expect(release).not.toBeNull();
    expect(await other.tryLock("automation:SETTLE:2026-11-25")).toBeNull();
    const morning = await other.tryLock("automation:MORNING:2026-11-25");
    expect(morning).not.toBeNull();
    await morning!();
    await release!();
    const again = await other.tryLock("automation:SETTLE:2026-11-25");
    expect(again).not.toBeNull();
    await again!();
  });

  it("liquidity: contracts per ET trading date from fills joined to markets", async () => {
    await pool.query(`INSERT INTO ticker_days (pda, symbol, trading_date, close_time, status) VALUES ('td1','META','2026-11-24', now(), 'OPEN')`);
    await pool.query(`INSERT INTO markets (pda, ticker_day_pda, symbol, trading_date, strike_cents, yes_mint, no_mint, vault, status, created_by, created_slot)
                      VALUES ('m1','td1','META','2026-11-24',68000,'y','n','v','TRADING','AUTO',1)`);
    const late = new Date(etToUnix("2026-11-24", 19, 30) * 1000); // 00:30 UTC next day, still the 24th in ET
    await pool.query(`INSERT INTO fills (signature, event_index, market_pda, seq, maker_order_id, maker, taker, taker_side, price_cents, qty, maker_intent, taker_intent, slot, block_time)
                      VALUES ('s1',0,'m1',1,1,'a','b','BID',50,40,'SELL_YES','BUY_YES',1,$1), ('s2',0,'m1',2,1,'a','b','BID',50,2,'SELL_YES','BUY_YES',1,$2)`,
      [late, new Date(etToUnix("2026-11-25", 10, 0) * 1000)]);
    const m = await store.contractsByDate("META", ["2026-11-24", "2026-11-25", "2026-11-23"]);
    expect([m.get("2026-11-24"), m.get("2026-11-25"), m.get("2026-11-23")]).toEqual([40n, 2n, 0n]);
    expect(await store.hasAnyFills("META")).toBe(true);
    expect(await store.hasAnyFills("AAPL")).toBe(false);
    expect((await store.fills("2026-11-24")).map((f) => f.signature)).toEqual(["s1"]);
  });
});
