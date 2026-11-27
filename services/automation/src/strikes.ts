/**
 * MER-41: dynamic strike generator (D5, spec 8.1, A13, D31).
 *
 * Integer cents and basis points with `bigint` only. There is no floating-point arithmetic
 * anywhere in this file (STK-04 checks the source), so the same frozen `strike_inputs`
 * row always gives the same strikes (STK-09).
 */

export type Tier = "A" | "B" | "C";
export type VolBasis = "IV" | "RV_FALLBACK";

/** The active `strike_policy` row. */
export interface StrikePolicy {
  id: number;
  stepLadderCents: bigint[];
  minStepBps: bigint;
  spacingMultBps: Record<Tier, bigint>;
  strikesPerSide: Record<Tier, bigint>;
  maxPerSide: bigint;
  coverageSigmaBps: bigint;
  ivFloorBps: bigint;
  ivCeilingBps: bigint;
  rvFallbackMultBps: bigint;
  tierAMinContracts: bigint;
  tierBMinContracts: bigint;
}

/** Spec 5 `strike_policy` defaults. */
export const DEFAULT_POLICY: StrikePolicy = {
  id: 1,
  stepLadderCents: [50n, 100n, 250n, 500n, 1000n, 2500n, 5000n],
  minStepBps: 25n,
  spacingMultBps: { A: 5000n, B: 7500n, C: 10000n },
  strikesPerSide: { A: 4n, B: 3n, C: 2n },
  maxPerSide: 6n,
  coverageSigmaBps: 20000n,
  ivFloorBps: 1500n,
  ivCeilingBps: 15000n,
  rvFallbackMultBps: 12000n,
  tierAMinContracts: 50000n,
  tierBMinContracts: 5000n,
};

export interface StrikeInputs {
  /** Previous official close (D3, A14), cents. */
  prevCloseCents: bigint;
  /** ATM implied vol, nearest expiry (D9); null when the vendor had none. */
  ivBps: bigint | null;
  /** 20-day realized vol from official closes. */
  rv20Bps: bigint;
  tier: Tier;
}

export interface StrikeResult {
  volUsedBps: bigint;
  volBasis: VolBasis;
  move1dCents: bigint;
  stepCents: bigint;
  perSide: bigint;
  /** Sorted ascending, unique, all > 0, ATM always included. */
  strikes: bigint[];
  atmCents: bigint;
  warnings: string[];
}

const BPS = 10_000n;
/** isqrt(252 × 10^16): sqrt(252) scaled by 10^8 and truncated. */
const SQRT252_E8 = isqrt(252n * 10n ** 16n);

export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrt of negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** Half-up rounding of num / den for num ≥ 0, den > 0. */
export function divRoundHalfUp(num: bigint, den: bigint): bigint {
  return (2n * num + den) / (2n * den);
}

/** Round a price to the nearest multiple of `step`, ties up (A13, STK-03). */
export function roundToStep(cents: bigint, step: bigint): bigint {
  return divRoundHalfUp(cents, step) * step;
}

function ceilDiv(num: bigint, den: bigint): bigint {
  return (num + den - 1n) / den;
}

function clamp(v: bigint, lo: bigint, hi: bigint): bigint {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Liquidity tier from the trailing 5-day average contracts per day (spec 8.1). */
export function tierFor(avgContracts: bigint, policy: StrikePolicy): Tier {
  if (avgContracts >= policy.tierAMinContracts) return "A";
  if (avgContracts >= policy.tierBMinContracts) return "B";
  return "C";
}

/** Vol used for spacing: IV, else RV20 × 1.2, clamped to [15%, 150%] (STK-10). */
export function volUsed(inputs: StrikeInputs, policy: StrikePolicy): { bps: bigint; basis: VolBasis } {
  const raw =
    inputs.ivBps !== null && inputs.ivBps > 0n
      ? { bps: inputs.ivBps, basis: "IV" as const }
      : { bps: (inputs.rv20Bps * policy.rvFallbackMultBps) / BPS, basis: "RV_FALLBACK" as const };
  return { bps: clamp(raw.bps, policy.ivFloorBps, policy.ivCeilingBps), basis: raw.basis };
}

export function generateStrikes(inputs: StrikeInputs, policy: StrikePolicy = DEFAULT_POLICY): StrikeResult {
  const p = inputs.prevCloseCents;
  if (p <= 0n) throw new RangeError(`previous close must be positive, got ${p}`);
  if (policy.stepLadderCents.length === 0) throw new RangeError("empty step ladder");
  const warnings: string[] = [];

  const vol = volUsed(inputs, policy);
  // move_1d = P × vol / sqrt(252), in cents, half-up.
  const move = divRoundHalfUp(p * vol.bps * 10n ** 8n, BPS * SQRT252_E8);
  const spacing = (move * policy.spacingMultBps[inputs.tier]) / BPS;
  const floor = ceilDiv(p * policy.minStepBps, BPS);
  const target = spacing > floor ? spacing : floor;
  const ladder = [...policy.stepLadderCents].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let step = ladder.find((s) => s >= target);
  if (step === undefined) {
    step = ladder[ladder.length - 1]!;
    warnings.push(`spacing ${target}c exceeds the largest ladder step; using ${step}c`);
  }

  const atm = roundToStep(p, step);
  const coverage = ceilDiv(policy.coverageSigmaBps * move, BPS * step);
  let n = policy.strikesPerSide[inputs.tier];
  if (coverage > n) n = coverage;
  if (n > policy.maxPerSide) n = policy.maxPerSide;

  const strikes: bigint[] = [];
  for (let k = -n; k <= n; k++) {
    const s = atm + k * step;
    if (s > 0n) strikes.push(s);
  }
  if (strikes.length < 3) warnings.push(`only ${strikes.length} strikes above zero`);

  return {
    volUsedBps: vol.bps,
    volBasis: vol.basis,
    move1dCents: move,
    stepCents: step,
    perSide: n,
    strikes,
    atmCents: atm,
    warnings,
  };
}
