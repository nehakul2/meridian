/**
 * Time helpers. Everything is stored and scheduled in UTC (spec 8); the America/New_York
 * wall clock is derived here with Intl, so DST transitions come from the tz database,
 * never from a hard-coded offset (R2.3, CAL-03, CAL-04).
 */

export const ET = "America/New_York";

/** An ET calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: ET,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function etParts(unixS: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(unixS * 1000))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

/** Seconds ET is ahead of UTC at this instant (−14400 in EDT, −18000 in EST). */
export function etOffsetS(unixS: number): number {
  const p = etParts(unixS);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) / 1000;
  return asUtc - unixS;
}

/** UTC unix seconds of an ET wall-clock time on an ET date. */
export function etToUnix(date: IsoDate, hh: number, mm: number, ss = 0): number {
  const [y, m, d] = parseIso(date);
  const naive = Date.UTC(y, m - 1, d, hh, mm, ss) / 1000;
  // Two passes settle the offset even on transition days (no market time is ambiguous).
  let t = naive - etOffsetS(naive);
  t = naive - etOffsetS(t);
  return t;
}

/** The ET calendar date of an instant. */
export function etDate(unixS: number): IsoDate {
  const p = etParts(unixS);
  return `${p.year}-${pad(p.month!)}-${pad(p.day!)}`;
}

/** `YYYYMMDD` as the u32 used in PDA seeds (D31, A16). */
export function dateKey(date: IsoDate): number {
  const [y, m, d] = parseIso(date);
  return y * 10_000 + m * 100 + d;
}

export function parseIso(date: IsoDate): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`bad date ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isoFromParts(y: number, m: number, d: number): IsoDate {
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Day of week of an ISO date: 0 = Sunday. */
export function weekday(date: IsoDate): number {
  const [y, m, d] = parseIso(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(date: IsoDate, n: number): IsoDate {
  const [y, m, d] = parseIso(date);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return isoFromParts(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Injectable clock: real time in production, a fake that jumps on sleep in tests. */
export interface Clock {
  /** UTC unix seconds. */
  now(): number;
  sleep(seconds: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Math.floor(Date.now() / 1000),
  sleep: (s) => new Promise((r) => setTimeout(r, Math.max(0, s) * 1000)),
};
