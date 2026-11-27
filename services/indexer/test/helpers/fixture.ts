/** The recorded day (test/fixtures/day.json) and a ChainSource that serves it. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChainEvent, groupByInstruction } from "../../../shared/src/events.js";
import { decodeTransaction, RawTx } from "../../src/decoder.js";
import type { ChainSource, SigInfo, SigStatus } from "../../src/source.js";

export interface Fixture {
  programId: string;
  date: string;
  markets: { m680: string; m720: string; tickerDay: string; config: string };
  users: Record<"alice" | "bob" | "carol" | "dave" | "erin" | "frank" | "disputer", string>;
  txs: (RawTx & { label: string })[];
}

const here = dirname(fileURLToPath(import.meta.url));
export const fixture: Fixture = JSON.parse(readFileSync(join(here, "../fixtures/day.json"), "utf8"));
export const quiet = { warn: () => undefined, info: () => undefined };

export function tx(label: string): RawTx & { label: string } {
  const t = fixture.txs.find((x) => x.label === label);
  if (!t) throw new Error(`no fixture tx ${label}`);
  return t;
}

export function allEvents(): ChainEvent[] {
  return fixture.txs.flatMap((t) => decodeTransaction(t, "confirmed", quiet));
}

export function allGroups(): ChainEvent[][] {
  return groupByInstruction(allEvents());
}

/** Name for a pubkey in the fixture (for readable assertions). */
export function nameOf(pk: string): string {
  for (const [k, v] of Object.entries(fixture.users)) if (v === pk) return k;
  for (const [k, v] of Object.entries(fixture.markets)) if (v === pk) return k;
  return pk;
}

export class FakeChain implements ChainSource {
  readonly txs: RawTx[] = [];
  finalizedSlot = 0;
  /** Signatures that never finalize (dropped by a fork). */
  readonly dropped = new Set<string>();
  private readonly listeners = new Set<(sig: string, slot: number, err: unknown) => void>();
  readonly calls: string[] = [];

  constructor(txs: RawTx[] = []) {
    this.txs.push(...txs);
  }

  /** A transaction lands (and is announced on the logs subscription). */
  land(t: RawTx, announce = true) {
    this.txs.push(t);
    if (announce) for (const l of this.listeners) l(t.signature, t.slot, null);
  }

  async getSignaturesForAddress(address: string, o: { before?: string; until?: string; limit?: number }): Promise<SigInfo[]> {
    this.calls.push(`sigs ${address.slice(0, 6)} until=${o.until?.slice(0, 6) ?? "-"}`);
    let list = this.txs.filter((t) => t.accountKeys.includes(address) && !this.dropped.has(t.signature)).reverse();
    if (o.before) list = list.slice(list.findIndex((t) => t.signature === o.before) + 1);
    if (o.until) {
      const i = list.findIndex((t) => t.signature === o.until);
      if (i >= 0) list = list.slice(0, i);
    }
    return list.slice(0, o.limit ?? 1000).map((t) => ({ signature: t.signature, slot: t.slot, err: null }));
  }

  async getTransaction(sig: string): Promise<RawTx | null> {
    this.calls.push(`tx ${sig.slice(0, 6)}`);
    if (this.dropped.has(sig)) return null;
    return this.txs.find((t) => t.signature === sig) ?? null;
  }

  async getSignatureStatuses(sigs: string[]): Promise<(SigStatus | null)[]> {
    return sigs.map((s) => {
      if (this.dropped.has(s)) return null;
      const t = this.txs.find((x) => x.signature === s);
      if (!t) return null;
      return { slot: t.slot, err: null, confirmationStatus: t.slot <= this.finalizedSlot ? "finalized" : "confirmed" };
    });
  }

  async getSlot(c: "confirmed" | "finalized") {
    return c === "finalized" ? this.finalizedSlot : Math.max(0, ...this.txs.map((t) => t.slot));
  }

  onLogs(cb: (sig: string, slot: number, err: unknown) => void) {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }
}

/** Instructions of the fixture's transactions up to and including `label` (first match). */
export function groupsThrough(label: string): ChainEvent[][] {
  const i = fixture.txs.findIndex((t) => t.label === label);
  return groupByInstruction(fixture.txs.slice(0, i + 1).flatMap((t) => decodeTransaction(t, "confirmed", quiet)));
}
