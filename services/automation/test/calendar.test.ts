// MER-40: trading calendar and corporate-action skips.
import { describe, expect, it } from "vitest";
import {
  buildCalendarYear, corporateActionSkip, CorporateActionFeed, holidays, NotATradingDay, TradingCalendar,
} from "../src/calendar.js";
import { dateKey, etDate, etToUnix } from "../src/time.js";
import { calendar2026 } from "./helpers/fakes.js";

const utc = (iso: string) => Date.parse(iso) / 1000;

describe("calendar", () => {
  const cal = calendar2026();

  it("CAL-01 exchange holiday has no row and is not a trading day", () => {
    expect(cal.isTradingDay("2026-11-26")).toBe(false); // Thanksgiving
    expect(() => cal.closeTime("2026-11-26")).toThrow(NotATradingDay);
    expect(cal.isTradingDay("2026-11-28")).toBe(false); // Saturday
  });

  it("CAL-02 day after Thanksgiving closes 13:00 ET (18:00 UTC)", () => {
    const r = cal.row("2026-11-27");
    expect(r.isHalfDay).toBe(true);
    expect(r.closeTime).toBe(utc("2026-11-27T18:00:00Z"));
    expect(cal.openTime("2026-11-27")).toBe(utc("2026-11-27T14:30:00Z"));
  });

  it("CAL-03 DST start: Friday close 21:00 UTC, Monday close 20:00 UTC", () => {
    expect(cal.closeTime("2026-03-06")).toBe(utc("2026-03-06T21:00:00Z"));
    expect(cal.closeTime("2026-03-09")).toBe(utc("2026-03-09T20:00:00Z"));
    expect(etToUnix("2026-03-06", 8, 0)).toBe(utc("2026-03-06T13:00:00Z"));
    expect(etToUnix("2026-03-09", 8, 0)).toBe(utc("2026-03-09T12:00:00Z"));
  });

  it("CAL-04 DST end: Friday close 20:00 UTC, Monday close 21:00 UTC", () => {
    expect(cal.closeTime("2026-10-30")).toBe(utc("2026-10-30T20:00:00Z"));
    expect(cal.closeTime("2026-11-02")).toBe(utc("2026-11-02T21:00:00Z"));
  });

  it("CAL-07 previous trading day skips weekends and holidays", () => {
    expect(cal.previousTradingDay("2026-11-30")).toBe("2026-11-27"); // Mon -> Fri half-day
    expect(cal.previousTradingDay("2026-11-27")).toBe("2026-11-25"); // skips Thanksgiving
    expect(cal.previousTradingDay("2026-01-02")).toBe("2025-12-31"); // skips New Year
    expect(cal.closeTime(cal.previousTradingDay("2026-11-30"))).toBe(utc("2026-11-27T18:00:00Z"));
  });

  it("2026 NYSE/Nasdaq holidays and early closes match the published schedule", () => {
    expect([...holidays(2026)].sort()).toEqual([
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
      "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    ]);
    const half = buildCalendarYear(2026).filter((r) => r.isHalfDay).map((r) => r.tradingDate);
    expect(half).toEqual(["2026-11-27", "2026-12-24"]);
    expect(buildCalendarYear(2026)).toHaveLength(251);
    // 2027: New Year on a Friday; 2022 rule check: Saturday New Year is not observed.
    expect(holidays(2022).has("2021-12-31")).toBe(false);
  });

  it("overrides add one-off closures and early closes", () => {
    const rows = buildCalendarYear(2026, { closed: ["2026-12-31"], halfDays: ["2026-12-30"] });
    const c = new TradingCalendar(rows);
    expect(c.isTradingDay("2026-12-31")).toBe(false);
    expect(c.row("2026-12-30").isHalfDay).toBe(true);
  });

  it("trading-date key is the ET date, also for UTC instants after midnight", () => {
    expect(dateKey("2026-11-25")).toBe(20261125);
    expect(etDate(utc("2026-11-26T01:00:00Z"))).toBe("2026-11-25"); // 20:00 ET
    expect(etDate(utc("2026-11-25T21:00:00Z"))).toBe("2026-11-25");
  });
});

describe("corporate actions (D25)", () => {
  const feed = (over: Partial<CorporateActionFeed> = {}): CorporateActionFeed => ({
    marketStatus: async () => "open",
    splits: async () => [],
    dividends: async () => [],
    ...over,
  });

  it("CAL-05 split day skips only that ticker", async () => {
    const rows = [{ symbol: "NVDA", effectiveDate: "2026-11-25", kind: "SPLIT", skipMarkets: true }];
    expect(await corporateActionSkip("NVDA", "2026-11-25", rows, null)).toMatchObject({ kind: "CORPORATE_ACTION" });
    expect(await corporateActionSkip("META", "2026-11-25", rows, null)).toBeNull();
    expect(await corporateActionSkip("NVDA", "2026-11-24", rows, null)).toBeNull();
  });

  it("a row with skip_markets = false does not skip", async () => {
    const rows = [{ symbol: "AAPL", effectiveDate: "2026-11-25", kind: "OTHER", skipMarkets: false }];
    expect(await corporateActionSkip("AAPL", "2026-11-25", rows, null)).toBeNull();
  });

  it("Massive split or special dividend skips; an ordinary dividend does not", async () => {
    expect(await corporateActionSkip("TSLA", "2026-11-25", [], feed({ splits: async () => [{ kind: "SPLIT" }] }))).toMatchObject({ kind: "SPLIT" });
    expect(await corporateActionSkip("MSFT", "2026-11-25", [], feed({ dividends: async () => [{ cashAmount: "3.00", special: true }] }))).toMatchObject({ kind: "DIVIDEND" });
    expect(await corporateActionSkip("MSFT", "2026-11-25", [], feed({ dividends: async () => [{ cashAmount: "0.83", special: false }] }))).toBeNull();
  });

  it("a vendor failure throws instead of silently skipping or creating", async () => {
    await expect(corporateActionSkip("AAPL", "2026-11-25", [], feed({ splits: async () => { throw new Error("503"); } }))).rejects.toThrow("503");
  });
});
