// MER-41: dynamic strike generator (spec 8.1).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, generateStrikes, roundToStep, StrikeInputs, Tier } from "../src/strikes.js";
import { strikesFromRow } from "../src/strikeInputs.js";
import { MemoryStore } from "../src/store/memory.js";

const range = (lo: number, hi: number, step: number) => {
  const out: bigint[] = [];
  for (let s = lo; s <= hi; s += step) out.push(BigInt(s));
  return out;
};
const inp = (p: number, iv: number | null, tier: Tier, rv = 0): StrikeInputs => ({
  prevCloseCents: BigInt(p), ivBps: iv === null ? null : BigInt(iv), rv20Bps: BigInt(rv), tier,
});

describe("strike generator", () => {
  it("STK-01 META worked example: step $10, 9 strikes 640 to 720", () => {
    const r = generateStrikes(inp(68000, 3500, "A"));
    expect(r.move1dCents).toBe(1499n);
    expect(r.stepCents).toBe(1000n);
    expect(r.strikes).toEqual(range(64000, 72000, 1000));
  });

  it("STK-02 AAPL no longer collapses: step $2.50, 9 strikes 220 to 240", () => {
    const r = generateStrikes(inp(23000, 2200, "A"));
    expect(r.stepCents).toBe(250n);
    expect(r.strikes).toEqual(range(22000, 24000, 250));
    expect(new Set(r.strikes).size).toBe(r.strikes.length);
  });

  it("STK-03 ties round half up", () => {
    expect(roundToStep(65500n, 1000n)).toBe(66000n);
    expect(roundToStep(64499n, 1000n)).toBe(64000n);
    expect(roundToStep(64500n, 1000n)).toBe(65000n);
    expect(roundToStep(22125n, 250n)).toBe(22250n);
  });

  it("STK-04 integer arithmetic only: exact reference and no float math in the strike path", () => {
    // P = 33333, IV 30%, tier B: move = round(33333 × 0.30 / sqrt(252)) = round(629.93) = 630.
    const r = generateStrikes(inp(33333, 3000, "B"));
    expect(r.move1dCents).toBe(630n);
    expect(r.stepCents).toBe(500n); // spacing 472 -> $5
    expect(r.atmCents).toBe(33500n);
    expect(r.strikes).toEqual(range(32000, 35000, 500));
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/strikes.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/Math\.|parseFloat|Number\(|\btoFixed\b/);
  });

  it("STK-05 ATM strike is always present (10k random prev closes)", () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31);
    const tiers: Tier[] = ["A", "B", "C"];
    for (let i = 0; i < 10_000; i++) {
      const p = BigInt(1000 + Math.floor(rand() * 200_000));
      const r = generateStrikes({ prevCloseCents: p, ivBps: BigInt(1000 + Math.floor(rand() * 15000)), rv20Bps: 0n, tier: tiers[i % 3]! });
      expect(r.strikes).toContain(roundToStep(p, r.stepCents));
    }
  });

  it("STK-06 volatility widens steps; liquidity sets count", () => {
    const tsla = generateStrikes(inp(25000, 6000, "B"));
    expect([tsla.stepCents, tsla.strikes]).toEqual([1000n, range(22000, 28000, 1000)]);
    const nvda = generateStrikes(inp(19000, 9000, "A"));
    expect([nvda.stepCents, nvda.strikes]).toEqual([1000n, range(15000, 23000, 1000)]);
    const thin = generateStrikes(inp(12000, null, "C", 2500)); // RV 25% x 1.2 = 30%
    expect(thin.volBasis).toBe("RV_FALLBACK");
    expect(thin.volUsedBps).toBe(3000n);
    expect([thin.stepCents, thin.strikes]).toEqual([250n, range(11500, 12500, 250)]);
  });

  it("STK-07 low price: no strike at or below zero; warns when fewer than 3", () => {
    const policy = { ...DEFAULT_POLICY, stepLadderCents: [1000n] };
    const r = generateStrikes(inp(900, 3000, "C"), policy);
    expect(r.strikes.every((s) => s > 0n)).toBe(true);
    expect(r.strikes[0]).toBe(1000n);
    const tiny = generateStrikes(inp(400, 3000, "C"), { ...DEFAULT_POLICY, stepLadderCents: [1000n], strikesPerSide: { A: 1n, B: 1n, C: 1n } });
    expect(tiny.strikes).toEqual([1000n]);
    expect(tiny.warnings.join()).toMatch(/only 1 strikes/);
  });

  it("STK-09 deterministic from a frozen row and its policy id", async () => {
    const store = new MemoryStore();
    store.policies = [DEFAULT_POLICY, { ...DEFAULT_POLICY, id: 2, strikesPerSide: { A: 6n, B: 6n, C: 6n } }];
    const row = {
      symbol: "META", tradingDate: "2026-11-25", prevCloseCents: 68000n, ivBps: 3500n, ivSource: "x", rv20Bps: 0n,
      volUsedBps: 3500n, volBasis: "IV" as const, liquidityContracts5d: 60000n, liquidityTier: "A" as const,
      move1dCents: 1499n, stepCents: 1000n, perSide: 4n, strikesCents: range(64000, 72000, 1000), policyId: 1, computedAt: 0,
    };
    const a = await strikesFromRow(store, row);
    const b = await strikesFromRow(store, row);
    expect(a).toEqual(b);
    expect(a).toEqual(row.strikesCents); // a newer active policy does not change an old row
    expect(await strikesFromRow(store, { ...row, policyId: 2 })).toHaveLength(13);
  });

  it("STK-10 IV missing falls back to RV20 x 1.2; vol clamped to floor and ceiling", () => {
    const fallback = generateStrikes(inp(50000, null, "B", 800));
    expect(fallback.volBasis).toBe("RV_FALLBACK");
    expect(fallback.volUsedBps).toBe(1500n); // 960 -> floor 1500
    const high = generateStrikes(inp(50000, 20000, "B"));
    expect(high.volBasis).toBe("IV");
    expect(high.volUsedBps).toBe(15000n);
  });

  it("STK-11 coverage reaches 2 one-day moves; at most 6 per side; step at least 0.25% of price", () => {
    const r = generateStrikes(inp(40000, 15000, "C"));
    expect(r.perSide).toBeLessThanOrEqual(6n);
    expect(r.strikes.length).toBeLessThanOrEqual(13);
    const reach = r.strikes[r.strikes.length - 1]! - r.atmCents;
    expect(reach * 1n >= 2n * r.move1dCents || r.perSide === 6n).toBe(true);
    const calm = generateStrikes(inp(100000, 1500, "A"));
    expect(calm.stepCents * 10000n).toBeGreaterThanOrEqual(100000n * 25n);
    expect(calm.strikes[calm.strikes.length - 1]! - calm.atmCents).toBeGreaterThanOrEqual(2n * calm.move1dCents);
  });

  it("rejects a zero or negative previous close", () => {
    expect(() => generateStrikes(inp(0, 3000, "A"))).toThrow(RangeError);
    expect(() => generateStrikes(inp(-5, 3000, "A"))).toThrow(RangeError);
  });
});
