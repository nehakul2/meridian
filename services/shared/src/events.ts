/**
 * Normalized Meridian program events (spec 4.6) as they travel on the `md:events` stream
 * and land in `chain_events.payload`. Shared by the Indexer (C6) and the PG Writer (C7).
 *
 * Normalization: pubkeys are base58 strings, u64/i64 are decimal strings (they exceed 2^53),
 * u8/u32/i32 are numbers, enums are UPPER_SNAKE strings, `ticker` is the trimmed symbol,
 * `evidence_hash` is hex, and `r#override` is `override`.
 */

export type Commitment = "confirmed" | "finalized";

export const EVENT_KINDS = [
  "MarketCreated", "OrderPlaced", "Fill", "OrderCancelled", "PairMinted", "PairMerged",
  "Withdrawn", "FeesSwept", "CloseRecorded", "DisputeRaised", "DisputeResolved",
  "CloseFinalized", "MarketSettled", "MarketVoided", "Redeemed", "Paused", "Unpaused",
  "BookClosed",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Control entries the Indexer appends about a signature, not about one event. */
export type ControlKind = "Finalized" | "Dropped";

/** Events whose `market` is a Config or TickerDay address and whose `seq` is 0. */
export const NON_MARKET_KINDS = new Set<string>([
  "CloseRecorded", "DisputeRaised", "DisputeResolved", "CloseFinalized", "Paused", "Unpaused",
]);

export type Payload = Record<string, string | number | boolean>;

/** One decoded event. (sig, ix, ev) is its natural key. */
export interface ChainEvent {
  sig: string;
  /** Top-level instruction index in the transaction. */
  ix: number;
  /** Event index within that instruction. */
  ev: number;
  /** Number of events the instruction emitted (lets consumers see whole instructions). */
  n: number;
  slot: number;
  blockTime: number | null;
  commitment: Commitment;
  kind: EventKind;
  /** Always has `market`, `slot`, `seq`. */
  payload: Payload;
}

/** A stream entry: an event or a control entry for a signature. */
export type StreamEntry =
  | ({ type: "event" } & ChainEvent)
  | { type: "control"; sig: string; slot: number; kind: ControlKind; commitment: Commitment };

export const STREAM_KEY = "md:events";
export const STREAM_MAXLEN = 1_000_000;
export const BACKFILL_KEY = "md:backfill";

export function market(e: ChainEvent): string {
  return String(e.payload.market);
}

export function seq(e: ChainEvent): bigint {
  return BigInt(e.payload.seq as string);
}

export function isMarketScoped(e: ChainEvent): boolean {
  return !NON_MARKET_KINDS.has(e.kind);
}

/** Stream entry → flat Redis field list (spec 6.3 fields plus `n` and `block_time`). */
export function toFields(e: StreamEntry): string[] {
  if (e.type === "control") {
    return ["sig", e.sig, "ix", "-1", "ev", "-1", "n", "0", "slot", String(e.slot), "commitment", e.commitment,
      "kind", e.kind, "payload", "{}", "block_time", ""];
  }
  return ["sig", e.sig, "ix", String(e.ix), "ev", String(e.ev), "n", String(e.n), "slot", String(e.slot),
    "commitment", e.commitment, "kind", e.kind, "payload", JSON.stringify(e.payload),
    "block_time", e.blockTime == null ? "" : String(e.blockTime)];
}

export function fromFields(fields: string[]): StreamEntry {
  const m = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) m.set(fields[i]!, fields[i + 1]!);
  const kind = m.get("kind")!;
  const commitment = m.get("commitment") as Commitment;
  if (kind === "Finalized" || kind === "Dropped") {
    return { type: "control", sig: m.get("sig")!, slot: Number(m.get("slot")), kind, commitment };
  }
  const bt = m.get("block_time");
  return {
    type: "event",
    sig: m.get("sig")!,
    ix: Number(m.get("ix")),
    ev: Number(m.get("ev")),
    n: Number(m.get("n") ?? "1"),
    slot: Number(m.get("slot")),
    blockTime: bt ? Number(bt) : null,
    commitment,
    kind: kind as EventKind,
    payload: JSON.parse(m.get("payload") ?? "{}") as Payload,
  };
}

/** Splits an ordered event list into whole instructions (same sig and ix). */
export function groupByInstruction(events: ChainEvent[]): ChainEvent[][] {
  const out: ChainEvent[][] = [];
  for (const e of events) {
    const last = out.at(-1);
    if (last && last[0]!.sig === e.sig && last[0]!.ix === e.ix) last.push(e);
    else out.push([e]);
  }
  return out;
}
