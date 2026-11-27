/**
 * Pure market helpers shared by the API, the Tx Builder and the WS Gateway: date keys,
 * the time-of-day phase (spec 7.1), the user-facing market status, the No view of the
 * one Yes book (A19), the question and summary copy (A31: "at or above"), and the
 * full-precision provisional outcome (R1.6).
 */

/** America/New_York calendar date of a unix time, as YYYYMMDD (D31). */
export function etDateKey(unixS: number): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(unixS * 1000));
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  return Number(`${get("year")}${get("month")}${get("day")}`);
}

export const keyToIso = (k: number | string) => {
  const s = String(k);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};

/** "2026-11-25" → 20261125, or null when not a valid date. */
export function isoToKey(s: unknown): number | null {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  return Number(s.replaceAll("-", ""));
}

export const iso = (unixS: number) => new Date(unixS * 1000).toISOString().replace(/\.000Z$/, "Z");

/** 68000 → "680.00" */
export function centsToDollars(cents: bigint | number): string {
  const c = BigInt(cents);
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}

/** micro-USDC → "$64.00" (rounded down to the cent). */
export function microToDollars(micro: bigint): string {
  return `$${centsToDollars(micro / 10_000n)}`;
}

export function question(symbol: string, strikeCents: bigint | number): string {
  return `Will ${symbol} close at or above $${centsToDollars(strikeCents)} today?`;
}

export type Phase = "PRE_OPEN" | "MINT_ONLY" | "TRADING" | "HALTED" | "SETTLING" | "PROVISIONAL" | "DISPUTED" | "SETTLED" | "CLOSED_DAY";

export interface DayTimes {
  mintOpenTime: number;
  openTime: number;
  closeTime: number;
}

/**
 * Protocol phase for the trading day. Before the close it follows the clock; after it,
 * the ticker-days' settlement state: none recorded → HALTED, some → SETTLING, all
 * recorded → PROVISIONAL (DISPUTED if any is disputed), all FINAL and every market
 * settled → SETTLED. No ticker-day today → PRE_OPEN on a trading day, else CLOSED_DAY.
 */
export function dayPhase(
  now: number,
  times: DayTimes | null,
  tdayStatuses: string[],
  allMarketsSettled: boolean,
  isTradingDay: boolean,
): Phase {
  if (!times) return isTradingDay ? "PRE_OPEN" : "CLOSED_DAY";
  if (now < times.mintOpenTime) return "PRE_OPEN";
  if (now < times.openTime) return "MINT_ONLY";
  if (now < times.closeTime) return "TRADING";
  const recorded = tdayStatuses.filter((s) => s && s !== "OPEN");
  if (recorded.length === 0) return "HALTED";
  if (tdayStatuses.includes("DISPUTED")) return "DISPUTED";
  if (recorded.length < tdayStatuses.length) return "SETTLING";
  if (tdayStatuses.every((s) => s === "FINAL")) return allMarketsSettled ? "SETTLED" : "SETTLING";
  return "PROVISIONAL";
}

export type MarketView = "PRE_OPEN" | "MINT_ONLY" | "TRADING" | "HALTED" | "SETTLED" | "VOID";

/** User-facing market status: the chain status, with the clock applied to TRADING (D12). */
export function marketStatus(chainStatus: string, now: number, t: Partial<DayTimes>): MarketView {
  if (chainStatus === "SETTLED" || chainStatus === "VOID" || chainStatus === "HALTED") return chainStatus;
  if (t.closeTime && now >= t.closeTime) return "HALTED";
  if (t.mintOpenTime && now < t.mintOpenTime) return "PRE_OPEN";
  if (t.openTime && now < t.openTime) return "MINT_ONLY";
  return "TRADING";
}

/** NO view of the one book (A19): No bids from Yes asks, No asks from Yes bids, at 100 − p. */
export function noView(bids: [number, number][], asks: [number, number][]): { bids: [number, number][]; asks: [number, number][] } {
  return {
    bids: asks.map(([p, q]) => [100 - p, q] as [number, number]),
    asks: bids.map(([p, q]) => [100 - p, q] as [number, number]),
  };
}

/** price × 10^expo ≥ strike_cents / 100, compared exactly (R1.6). */
export function closesAtOrAbove(priceRaw: bigint, expo: number, strikeCents: bigint): boolean {
  if (expo >= 0) return priceRaw * 100n * 10n ** BigInt(expo) >= strikeCents;
  return priceRaw * 100n >= strikeCents * 10n ** BigInt(-expo);
}

export type Intent = "BUY_YES" | "SELL_YES" | "BUY_NO" | "SELL_NO";

/**
 * Summary copy (A31, API-04). Buys: "You pay up to $64.00. You win $100.00 if META closes
 * at or above $680.00." Sells: "You receive at least $X. You give up $Y if …".
 */
export function summaryCopy(intent: Intent, symbol: string, strikeCents: bigint, qty: bigint, priceCents: number, fee: bigint): string {
  const k = `$${centsToDollars(strikeCents)}`;
  const notional = qty * BigInt(priceCents) * 10_000n;
  const payout = microToDollars(qty * 1_000_000n);
  const yesCond = `at or above ${k}`;
  const noCond = `below ${k}`;
  switch (intent) {
    case "BUY_YES":
      return `You pay up to ${microToDollars(notional + fee)}. You win ${payout} if ${symbol} closes ${yesCond}.`;
    case "BUY_NO":
      return `You pay up to ${microToDollars(notional + fee)}. You win ${payout} if ${symbol} closes ${noCond}.`;
    case "SELL_YES":
      return `You receive at least ${microToDollars(notional - fee)}. You give up ${payout} if ${symbol} closes ${yesCond}.`;
    case "SELL_NO":
      return `You receive at least ${microToDollars(notional - fee)}. You give up ${payout} if ${symbol} closes ${noCond}.`;
  }
}

/** Taker fee on a notional, rounded up (program MER-25). */
export function takerFee(notionalMicro: bigint, feeBps: number): bigint {
  if (feeBps <= 0) return 0n;
  return (notionalMicro * BigInt(feeBps) + 9_999n) / 10_000n;
}
