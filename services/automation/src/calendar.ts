/**
 * MER-40: trading calendar and corporate-action skips (D25, A15, spec 5 and 8).
 *
 * The exchange calendar source is the published NYSE/Nasdaq holiday and early-close rules
 * (the two exchanges share them), plus an overrides list for one-off closures such as a
 * national day of mourning. Holidays get no `trading_calendar` row; half-days close at
 * 13:00 ET. All times are stored as UTC.
 */
import { addDays, etToUnix, isoFromParts, IsoDate, parseIso, weekday } from "./time.js";

export interface CalendarRow {
  tradingDate: IsoDate;
  /** UTC unix seconds. */
  openTime: number;
  closeTime: number;
  isHalfDay: boolean;
}

export interface CalendarOverrides {
  /** Extra full closures (YYYY-MM-DD). */
  closed?: IsoDate[];
  /** Extra 13:00 ET early closes. */
  halfDays?: IsoDate[];
}

function nthWeekday(y: number, month: number, dow: number, n: number): IsoDate {
  const first = isoFromParts(y, month, 1);
  const shift = (dow - weekday(first) + 7) % 7;
  return addDays(first, shift + 7 * (n - 1));
}

function lastWeekday(y: number, month: number, dow: number): IsoDate {
  const nextFirst = month === 12 ? isoFromParts(y + 1, 1, 1) : isoFromParts(y, month + 1, 1);
  const last = addDays(nextFirst, -1);
  return addDays(last, -((weekday(last) - dow + 7) % 7));
}

/** Gregorian Easter Sunday (anonymous algorithm). */
function easter(y: number): IsoDate {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return isoFromParts(y, month, day);
}

/** Saturday holidays move to Friday, Sunday ones to Monday (NYSE Rule 7.2). */
function observed(date: IsoDate): IsoDate {
  const wd = weekday(date);
  if (wd === 6) return addDays(date, -1);
  if (wd === 0) return addDays(date, 1);
  return date;
}

/** Full-day exchange holidays for a year. */
export function holidays(y: number): Set<IsoDate> {
  const out = new Set<IsoDate>();
  // New Year's Day: a Saturday New Year is not observed on the prior Friday (Rule 7.2).
  const ny = isoFromParts(y, 1, 1);
  if (weekday(ny) !== 6) out.add(observed(ny));
  out.add(nthWeekday(y, 1, 1, 3)); // Martin Luther King Jr. Day
  out.add(nthWeekday(y, 2, 1, 3)); // Washington's Birthday
  out.add(addDays(easter(y), -2)); // Good Friday
  out.add(lastWeekday(y, 5, 1)); // Memorial Day
  if (y >= 2022) out.add(observed(isoFromParts(y, 6, 19))); // Juneteenth
  out.add(observed(isoFromParts(y, 7, 4))); // Independence Day
  out.add(nthWeekday(y, 9, 1, 1)); // Labor Day
  out.add(nthWeekday(y, 11, 4, 4)); // Thanksgiving
  out.add(observed(isoFromParts(y, 12, 25))); // Christmas
  return out;
}

/** 13:00 ET early closes: July 3 (Mon to Thu), day after Thanksgiving, Christmas Eve (Mon to Thu). */
export function halfDays(y: number): Set<IsoDate> {
  const out = new Set<IsoDate>();
  const jul3 = isoFromParts(y, 7, 3);
  if (weekday(jul3) >= 1 && weekday(jul3) <= 4) out.add(jul3);
  out.add(addDays(nthWeekday(y, 11, 4, 4), 1));
  const dec24 = isoFromParts(y, 12, 24);
  if (weekday(dec24) >= 1 && weekday(dec24) <= 4) out.add(dec24);
  return out;
}

/** Calendar rows for every trading day of a year. */
export function buildCalendarYear(y: number, overrides: CalendarOverrides = {}): CalendarRow[] {
  const closed = holidays(y);
  for (const d of overrides.closed ?? []) closed.add(d);
  const half = halfDays(y);
  for (const d of overrides.halfDays ?? []) half.add(d);
  const rows: CalendarRow[] = [];
  for (let d = isoFromParts(y, 1, 1); parseIso(d)[0] === y; d = addDays(d, 1)) {
    const wd = weekday(d);
    if (wd === 0 || wd === 6 || closed.has(d)) continue;
    const isHalfDay = half.has(d);
    rows.push({
      tradingDate: d,
      openTime: etToUnix(d, 9, 30),
      closeTime: etToUnix(d, isHalfDay ? 13 : 16, 0),
      isHalfDay,
    });
  }
  return rows;
}

/** Read-side helpers over loaded `trading_calendar` rows. */
export class TradingCalendar {
  private readonly byDate = new Map<IsoDate, CalendarRow>();
  private readonly sorted: IsoDate[];

  constructor(rows: CalendarRow[]) {
    for (const r of rows) this.byDate.set(r.tradingDate, r);
    this.sorted = [...this.byDate.keys()].sort();
  }

  isTradingDay(date: IsoDate): boolean {
    return this.byDate.has(date);
  }

  row(date: IsoDate): CalendarRow {
    const r = this.byDate.get(date);
    if (!r) throw new NotATradingDay(date);
    return r;
  }

  /** UTC unix seconds of the close (16:00 or 13:00 ET). */
  closeTime(date: IsoDate): number {
    return this.row(date).closeTime;
  }

  openTime(date: IsoDate): number {
    return this.row(date).openTime;
  }

  /** Minting opens at 08:30 ET (D26). */
  mintOpenTime(date: IsoDate): number {
    this.row(date);
    return etToUnix(date, 8, 30);
  }

  /** Last trading day strictly before `date` (skips weekends and holidays, CAL-07). */
  previousTradingDay(date: IsoDate): IsoDate {
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.sorted[mid]! < date) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) throw new Error(`no trading day before ${date} in the loaded calendar`);
    return this.sorted[lo - 1]!;
  }

  dates(): IsoDate[] {
    return [...this.sorted];
  }
}

export class NotATradingDay extends Error {
  constructor(public readonly date: IsoDate) {
    super(`${date} is not a trading day`);
  }
}

/** Why a ticker is skipped on a date, or null to create its markets (D25). */
export type SkipReason = { kind: "CORPORATE_ACTION" | "MARKET_STATUS" | "SPLIT" | "DIVIDEND"; detail: string };

export interface CorporateActionRow {
  symbol: string;
  effectiveDate: IsoDate;
  kind: string;
  skipMarkets: boolean;
}

/** Morning-time vendor gate (Massive market-status, splits, dividends), D25. */
export interface CorporateActionFeed {
  /** Exchange status for the day ("open", "early-close", "closed"); null if unknown. */
  marketStatus(date: IsoDate): Promise<string | null>;
  splits(symbol: string, date: IsoDate): Promise<{ kind: string }[]>;
  /** Dividends with ex-date on `date`. */
  dividends(symbol: string, date: IsoDate): Promise<{ cashAmount: string; special: boolean }[]>;
}

/**
 * Decides whether `symbol` trades today. A `corporate_actions` row with `skip_markets`
 * wins; then the vendor's split and special-dividend data. Ordinary cash dividends do
 * not skip (they do not change the settlement reference). A vendor failure does not
 * skip silently: it throws, so the morning job retries and pages.
 */
export async function corporateActionSkip(
  symbol: string,
  date: IsoDate,
  rows: CorporateActionRow[],
  feed: CorporateActionFeed | null,
): Promise<SkipReason | null> {
  const row = rows.find((r) => r.symbol === symbol && r.effectiveDate === date && r.skipMarkets);
  if (row) return { kind: "CORPORATE_ACTION", detail: `${row.kind} effective ${date}` };
  if (!feed) return null;
  const splits = await feed.splits(symbol, date);
  if (splits.length > 0) return { kind: "SPLIT", detail: `${splits[0]!.kind} on ${date} (Massive)` };
  const divs = await feed.dividends(symbol, date);
  const special = divs.find((d) => d.special);
  if (special) return { kind: "DIVIDEND", detail: `special dividend ${special.cashAmount} ex ${date} (Massive)` };
  return null;
}
