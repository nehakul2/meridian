/**
 * Client copy of one market's book (MER-72). The book is held in Yes terms only; the No
 * view is derived at render time with the shared `noView` (A19), so both views always come
 * from the same levels and the same seq.
 *
 * Deltas from the gateway carry `seq` and `prev_seq` (the snapshot seq they apply to,
 * Phase 6). A delta at or below the current seq is stale and ignored; one whose `prev_seq`
 * is not the current seq means one was lost, and the caller asks for a fresh snapshot.
 */
import type { Level, View } from "./types";
import { noView } from "../../../services/shared/src/market";

export interface BookState {
  seq: bigint;
  bids: Map<number, number>;
  asks: Map<number, number>;
}

export interface BookDelta {
  type: "book_delta";
  seq: string;
  prev_seq?: string;
  changes: ["B" | "A", number, number][];
}

export function fromSnapshot(s: { seq: string; bids: Level[]; asks: Level[] }): BookState {
  return { seq: BigInt(s.seq), bids: new Map(s.bids), asks: new Map(s.asks) };
}

export type DeltaResult = { kind: "applied"; book: BookState } | { kind: "stale" } | { kind: "gap" };

export function applyDelta(b: BookState, d: BookDelta): DeltaResult {
  const seq = BigInt(d.seq);
  if (seq <= b.seq) return { kind: "stale" };
  if (d.prev_seq !== undefined && BigInt(d.prev_seq) !== b.seq) return { kind: "gap" };
  const bids = new Map(b.bids);
  const asks = new Map(b.asks);
  for (const [s, p, q] of d.changes) {
    const side = s === "B" ? bids : asks;
    if (q > 0) side.set(p, q);
    else side.delete(p);
  }
  return { kind: "applied", book: { seq, bids, asks } };
}

/** Sorted levels for a view: bids high to low, asks low to high, in that view's prices. */
export function levels(b: BookState, view: View, depth = 10): { bids: Level[]; asks: Level[] } {
  const yb = [...b.bids.entries()].sort((x, y) => y[0] - x[0]);
  const ya = [...b.asks.entries()].sort((x, y) => x[0] - y[0]);
  const v = view === "NO" ? noView(yb, ya) : { bids: yb, asks: ya };
  return { bids: v.bids.slice(0, depth), asks: v.asks.slice(0, depth) };
}

export function bestPrices(b: BookState): { bid: number | null; ask: number | null } {
  let bid: number | null = null;
  let ask: number | null = null;
  for (const p of b.bids.keys()) if (bid === null || p > bid) bid = p;
  for (const p of b.asks.keys()) if (ask === null || p < ask) ask = p;
  return { bid, ask };
}
