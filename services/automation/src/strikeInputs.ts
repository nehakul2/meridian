/**
 * MER-49: strike inputs (D5, D9, spec 8.1), frozen once per ticker-day into
 * `strike_inputs` at 08:00 ET before strikes are generated; a rerun reuses the row.
 *
 * - IV: Massive ATM implied vol, nearest listed expiry (MassiveClient.atmImpliedVol).
 * - RV20: annualised standard deviation of the last 20 daily returns of official closes
 *   (simple returns, which match log returns to well under 1 bp at daily scale), in
 *   integer fixed point so the frozen value is reproducible.
 * - Liquidity: trailing 5-trading-day average contracts per day from `fills`;
 *   `tickers.liquidity_tier_override` wins; a ticker with no fills history is tier B.
 */
import type { TradingCalendar } from "./calendar.js";
import type { Store, StrikeInputsRow } from "./store/types.js";
import { divRoundHalfUp, generateStrikes, isqrt, Tier, tierFor } from "./strikes.js";
import type { IsoDate } from "./time.js";
import type { IvSource } from "./vendors/massive.js";
import type { Logger } from "./alerts.js";

const SCALE = 1_000_000_000n;
const SQRT252_E8 = isqrt(252n * 10n ** 16n);

/** RV over the closes given (oldest first), in bps; null with fewer than 3 closes. */
export function realizedVolBps(closesOldestFirst: bigint[]): bigint | null {
  if (closesOldestFirst.length < 3) return null;
  const r: bigint[] = [];
  for (let i = 1; i < closesOldestFirst.length; i++) {
    const prev = closesOldestFirst[i - 1]!;
    r.push(((closesOldestFirst[i]! - prev) * SCALE) / prev);
  }
  const n = BigInt(r.length);
  const sum = r.reduce((a, b) => a + b, 0n);
  // Sample variance in SCALE^2 units: (n·Σr² − (Σr)²) / (n·(n−1)).
  const sumSq = r.reduce((a, b) => a + b * b, 0n);
  const varS2 = (n * sumSq - sum * sum) / (n * (n - 1n));
  const sd = isqrt(varS2 < 0n ? 0n : varS2);
  return divRoundHalfUp(sd * 10_000n * SQRT252_E8, SCALE * 10n ** 8n);
}

export interface StrikeInputDeps {
  store: Store;
  iv: IvSource | null;
  calendar: TradingCalendar;
  log: Logger;
  now: () => number;
}

export async function freezeStrikeInputs(
  deps: StrikeInputDeps,
  symbol: string,
  date: IsoDate,
  prevCloseCents: bigint,
  tierOverride: Tier | null,
): Promise<{ row: StrikeInputsRow; reused: boolean; warnings: string[] }> {
  const existing = await deps.store.getStrikeInputs(symbol, date);
  if (existing) return { row: existing, reused: true, warnings: [] };
  const policy = await deps.store.activePolicy();

  let ivBps: bigint | null = null;
  let ivSource: string | null = null;
  if (deps.iv) {
    try {
      const snap = await deps.iv.atmImpliedVol(symbol, date, prevCloseCents);
      if (snap) {
        ivBps = snap.ivBps;
        ivSource = `MASSIVE ${snap.expiry} K=${snap.strikeCents} @${new Date(deps.now() * 1000).toISOString()}`;
      }
    } catch (e) {
      deps.log.warn("IV fetch failed; using RV fallback", { symbol, date, error: (e as Error).message });
    }
  }

  const closes = (await deps.store.officialClosesBefore(symbol, date, 21)).map((c) => c.priceCents).reverse();
  const rv20 = realizedVolBps(closes) ?? 0n;

  // Trailing 5 trading days before `date`.
  const days: IsoDate[] = [];
  let d = date;
  for (let i = 0; i < 5; i++) {
    d = deps.calendar.previousTradingDay(d);
    days.push(d);
  }
  const byDay = await deps.store.contractsByDate(symbol, days);
  const total = [...byDay.values()].reduce((a, b) => a + b, 0n);
  const avg = total / 5n;
  const tier: Tier = tierOverride ?? ((await deps.store.hasAnyFills(symbol)) ? tierFor(avg, policy) : "B");

  const res = generateStrikes({ prevCloseCents, ivBps, rv20Bps: rv20, tier }, policy);
  const row = await deps.store.putStrikeInputs({
    symbol,
    tradingDate: date,
    prevCloseCents,
    ivBps,
    ivSource,
    rv20Bps: rv20,
    volUsedBps: res.volUsedBps,
    volBasis: res.volBasis,
    liquidityContracts5d: avg,
    liquidityTier: tier,
    move1dCents: res.move1dCents,
    stepCents: res.stepCents,
    perSide: res.perSide,
    strikesCents: res.strikes,
    policyId: policy.id,
    computedAt: deps.now(),
  });
  return { row, reused: false, warnings: res.warnings };
}

/** Recomputes strikes from a stored row and the policy it names (STK-09). */
export async function strikesFromRow(store: Store, row: StrikeInputsRow): Promise<bigint[]> {
  const policy = await store.policy(row.policyId);
  return generateStrikes(
    { prevCloseCents: row.prevCloseCents, ivBps: row.ivBps, rv20Bps: row.rv20Bps, tier: row.liquidityTier },
    policy,
  ).strikes;
}
