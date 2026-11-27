/**
 * The official closing-auction price (D3) from Massive and Databento, which must match
 * exactly (D13). Never written from one vendor; the first matching value is stored and
 * never swapped (spec 4.7 rule 2).
 */
import type { OfficialCloseRow, Store } from "../store/types.js";
import type { IsoDate } from "../time.js";
import type { OfficialCloseSource } from "../vendors/massive.js";

export type CloseLookup =
  | { kind: "STORED"; row: OfficialCloseRow }
  | { kind: "MATCHED"; row: OfficialCloseRow }
  | { kind: "MISMATCH"; massive: bigint; databento: bigint }
  | { kind: "PENDING"; massive: bigint | null; databento: bigint | null; errors: string[] };

export interface CloseSources {
  massive: OfficialCloseSource;
  databento: OfficialCloseSource;
}

export async function lookupOfficialClose(
  store: Store,
  sources: CloseSources,
  symbol: string,
  date: IsoDate,
  now: number,
): Promise<CloseLookup> {
  const stored = await store.getOfficialClose(symbol, date);
  if (stored) return { kind: "STORED", row: stored };
  const errors: string[] = [];
  const get = async (s: OfficialCloseSource) => {
    try {
      return (await s.officialClose(symbol, date))?.cents ?? null;
    } catch (e) {
      errors.push((e as Error).message);
      return null;
    }
  };
  const [m, d] = await Promise.all([get(sources.massive), get(sources.databento)]);
  if (m !== null && d !== null) {
    if (m !== d) return { kind: "MISMATCH", massive: m, databento: d };
    const row = await store.putOfficialClose({
      symbol,
      tradingDate: date,
      priceCents: m,
      massiveCents: m,
      massiveAt: now,
      databentoCents: d,
      databentoAt: now,
    });
    return { kind: "MATCHED", row };
  }
  return { kind: "PENDING", massive: m, databento: d, errors };
}

/** Cents to a mantissa at the reference update's exponent; exact or it throws (Phase 3 rule). */
export function centsAtExpo(cents: bigint, expo: number): bigint {
  const shift = expo + 2; // cents are 10^-2
  if (shift <= 0) return cents * 10n ** BigInt(-shift);
  const div = 10n ** BigInt(shift);
  if (cents % div !== 0n) throw new Error(`${cents} cents is not exact at expo ${expo}`);
  return cents / div;
}

export function formatCents(c: bigint): string {
  const s = c.toString().padStart(3, "0");
  return `$${s.slice(0, -2)}.${s.slice(-2)}`;
}
