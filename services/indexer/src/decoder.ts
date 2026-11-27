/**
 * MER-50: decodes Meridian events from a transaction. Events are emitted with
 * `emit_cpi!`, i.e. as a self-CPI whose data is EVENT_IX_TAG_LE ‖ discriminator ‖ borsh,
 * so they live in the transaction's inner instructions (not in the logs). Every spec 4.6
 * event is decoded through the committed IDL; an unknown discriminator is logged and skipped.
 */
import { utils } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { ChainEvent, Commitment, EVENT_KINDS, EventKind, Payload } from "../../shared/src/events.js";
import { coder, PROGRAM_ID } from "./idl.js";

/** anchor_lang::event::EVENT_IX_TAG (0x1d9acb512ea545e4) little-endian. */
export const EVENT_IX_TAG_LE = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

/** The parts of an RPC `getTransaction` (json encoding) result the decoder reads. */
export interface RawTx {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  /** Static keys, then loaded writable, then loaded readonly (v0). */
  accountKeys: string[];
  innerInstructions: { index: number; instructions: { programIdIndex: number; data: string }[] }[];
}

export interface Logger {
  warn(msg: string, extra?: Record<string, unknown>): void;
  info?(msg: string, extra?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  warn: (msg, extra) => console.warn(JSON.stringify({ level: "warn", msg, ...extra })),
  info: (msg, extra) => console.log(JSON.stringify({ level: "info", msg, ...extra })),
};

const KNOWN = new Set<string>(EVENT_KINDS);

/** `IocRemainder` → `IOC_REMAINDER`. */
export function upperSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

function normalizeValue(key: string, v: unknown): string | number | boolean {
  if (v instanceof PublicKey) return v.toBase58();
  if (BN.isBN(v)) return (v as BN).toString();
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
  if (Array.isArray(v) || v instanceof Uint8Array) {
    const bytes = Buffer.from(v as number[]);
    if (key === "ticker") return bytes.toString("utf8").replace(/\0+$/, "").trim();
    return bytes.toString("hex");
  }
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 1) return upperSnake(keys[0]!.charAt(0).toUpperCase() + keys[0]!.slice(1)); // enum
  }
  throw new Error(`cannot normalize field ${key}`);
}

export function normalizePayload(data: Record<string, unknown>): Payload {
  const out: Payload = {};
  for (const [k, v] of Object.entries(data)) {
    const key = k.replace(/^r#/, "");
    out[key] = normalizeValue(key, v);
  }
  return out;
}

/** Decodes one event CPI's data, or null when it is not a Meridian event we know. */
export function decodeEventData(data: Uint8Array, log: Logger = consoleLogger, where: Record<string, unknown> = {}):
  { kind: EventKind; payload: Payload } | null {
  const buf = Buffer.from(data);
  if (buf.length < 16 || !buf.subarray(0, 8).equals(EVENT_IX_TAG_LE)) return null;
  const decoded = coder.events.decode(buf.subarray(8).toString("base64"));
  if (!decoded) {
    log.warn("unknown event discriminator; skipped", { ...where, disc: buf.subarray(8, 16).toString("hex") });
    return null;
  }
  if (!KNOWN.has(decoded.name)) {
    log.warn("event kind not in the Indexer contract; skipped", { ...where, kind: decoded.name });
    return null;
  }
  return { kind: decoded.name as EventKind, payload: normalizePayload(decoded.data as Record<string, unknown>) };
}

/**
 * All Meridian events in a transaction, in emission order. Failed transactions emit
 * nothing (their CPIs were rolled back).
 */
export function decodeTransaction(tx: RawTx, commitment: Commitment, log: Logger = consoleLogger): ChainEvent[] {
  if (tx.err) return [];
  const program = PROGRAM_ID.toBase58();
  const out: ChainEvent[] = [];
  const inner = [...tx.innerInstructions].sort((a, b) => a.index - b.index);
  for (const group of inner) {
    const found: { kind: EventKind; payload: Payload }[] = [];
    for (const ix of group.instructions) {
      if (tx.accountKeys[ix.programIdIndex] !== program) continue;
      const d = decodeEventData(utils.bytes.bs58.decode(ix.data), log, { sig: tx.signature, ix: group.index });
      if (d) found.push(d);
    }
    found.forEach((d, ev) => out.push({
      sig: tx.signature, ix: group.index, ev, n: found.length, slot: tx.slot, blockTime: tx.blockTime,
      commitment, kind: d.kind, payload: d.payload,
    }));
  }
  return out;
}

/** RPC `getTransaction` json result → RawTx. */
export function fromRpc(signature: string, r: {
  slot: number; blockTime?: number | null;
  transaction: { message: { accountKeys?: (string | { toBase58(): string })[]; staticAccountKeys?: { toBase58(): string }[] } };
  meta: { err: unknown; innerInstructions?: { index: number; instructions: { programIdIndex: number; data: string }[] }[] | null;
    loadedAddresses?: { writable: (string | { toBase58(): string })[]; readonly: (string | { toBase58(): string })[] } } | null;
}): RawTx {
  const s = (k: string | { toBase58(): string }) => (typeof k === "string" ? k : k.toBase58());
  const msg = r.transaction.message;
  const keys = (msg.accountKeys ?? msg.staticAccountKeys ?? []).map(s);
  const la = r.meta?.loadedAddresses;
  if (la) keys.push(...la.writable.map(s), ...la.readonly.map(s));
  return {
    signature, slot: r.slot, blockTime: r.blockTime ?? null, err: r.meta?.err ?? null, accountKeys: keys,
    innerInstructions: r.meta?.innerInstructions ?? [],
  };
}
