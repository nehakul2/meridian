/**
 * The Indexer core (C6): decode → append to `md:events` → project into Redis → advance
 * the cursor. MER-50 (decode, append, cursor), MER-51 (projection), MER-52 (backfill,
 * served backfill requests) and the finality tracking the PG Writer needs for reorgs
 * (spec 5: rows promoted to finalized, dropped signatures deleted).
 */
import type { Redis } from "ioredis";
import {
  BACKFILL_KEY, ChainEvent, Commitment, groupByInstruction, isMarketScoped,
} from "../../shared/src/events.js";
import { consoleLogger, decodeTransaction, Logger, RawTx } from "./decoder.js";
import type { CursorStore } from "./cursor.js";
import { PROGRAM_ID } from "./idl.js";
import { K } from "../../shared/src/keys.js";
import type { Projector } from "./projector.js";
import type { ChainSource } from "./source.js";
import type { EventStream } from "./stream.js";

export const CURSOR = "program_logs";

const SET_MAX = `local c = tonumber(redis.call('GET', KEYS[1]) or '0') if tonumber(ARGV[1]) > c then redis.call('SET', KEYS[1], ARGV[1]) end return 1`;

export interface IndexerDeps {
  redis: Redis;
  source: ChainSource;
  cursor: CursorStore;
  projector: Projector;
  stream: EventStream;
  log?: Logger;
  /** Fencing token check for md:slot (same lease as the stream). */
  isLeader?: () => boolean;
}

export class Indexer {
  readonly log: Logger;
  /** Signatures seen at confirmed and not yet finalized: sig → slot and markets touched. */
  readonly pending = new Map<string, { slot: number; markets: Set<string>; owners: Set<string> }>();
  private backfillGroupStarted = false;

  constructor(private readonly d: IndexerDeps) {
    this.log = d.log ?? consoleLogger;
  }

  /**
   * Indexes one transaction. Only `confirmed` (and `finalized`) data is shown to users
   * (R6.6, IDX-10): a `processed` notification is ignored. Returns the number of new
   * stream entries.
   */
  async processTransaction(tx: RawTx, commitment: Commitment | "processed"): Promise<number> {
    if (commitment === "processed") return 0;
    const events = decodeTransaction(tx, commitment, this.log);
    let appended = 0;
    for (const e of events) if (await this.d.stream.append({ type: "event", ...e })) appended++;
    for (const g of groupByInstruction(events)) await this.d.projector.applyInstruction(g);
    if (events.length > 0 && commitment === "confirmed") {
      const markets = new Set(events.filter(isMarketScoped).map((e) => String(e.payload.market)));
      const owners = new Set<string>();
      for (const e of events) for (const k of ["owner", "maker", "taker"]) if (typeof e.payload[k] === "string") owners.add(e.payload[k] as string);
      this.pending.set(tx.signature, { slot: tx.slot, markets, owners });
    }
    // The cursor moves only after every entry is in the stream.
    if (!this.d.isLeader || this.d.isLeader()) await this.d.redis.eval(SET_MAX, 1, K.slot, String(tx.slot));
    const cur = await this.d.cursor.get(CURSOR);
    if (!cur || tx.slot >= cur.lastSlot) await this.d.cursor.set(CURSOR, { lastSlot: tx.slot, lastSignature: tx.signature });
    return appended;
  }

  async processSignature(sig: string, attempts = 5): Promise<number> {
    for (let i = 0; i < attempts; i++) {
      const tx = await this.d.source.getTransaction(sig);
      if (tx) return this.processTransaction(tx, "confirmed");
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
    this.log.warn("transaction not found after retries", { sig });
    return 0;
  }

  /** Every program signature after `until`, oldest first. */
  private async signaturesSince(address: string, until?: string): Promise<string[]> {
    const out: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.d.source.getSignaturesForAddress(address, { before, until, limit: 1000 });
      for (const s of page) if (!s.err) out.push(s.signature);
      if (page.length < 1000) break;
      before = page.at(-1)!.signature;
    }
    return out.reverse();
  }

  /**
   * Backfills from the last processed signature (MER-52: a new leader runs this before
   * going live). Already-appended events are skipped by the stream's dedupe.
   */
  async backfill(): Promise<{ signatures: number; appended: number }> {
    const cur = await this.d.cursor.get(CURSOR);
    const sigs = await this.signaturesSince(PROGRAM_ID.toBase58(), cur?.lastSignature ?? undefined);
    let appended = 0;
    for (const s of sigs) appended += await this.processSignature(s);
    return { signatures: sigs.length, appended };
  }

  /** A market's whole history from RPC, as instructions in seq order. */
  async marketHistory(m: string, exclude: Set<string> = new Set()): Promise<ChainEvent[][]> {
    const sigs = await this.signaturesSince(m);
    const groups: ChainEvent[][] = [];
    for (const s of sigs) {
      if (exclude.has(s)) continue;
      const tx = await this.d.source.getTransaction(s);
      if (!tx) continue;
      const evs = decodeTransaction(tx, "confirmed", this.log).filter((e) => isMarketScoped(e) && e.payload.market === m);
      groups.push(...groupByInstruction(evs));
    }
    return groups.sort((a, b) => Number(BigInt(a[0]!.payload.seq as string) - BigInt(b[0]!.payload.seq as string)));
  }

  /**
   * Serves the PG Writer's gap backfill requests (IDX-04): re-reads the market's
   * signatures, appends whatever the stream is missing, and rebuilds the market's Redis
   * state from history if a late event landed behind newer ones.
   */
  async serveBackfillRequests(blockMs = 0): Promise<number> {
    if (!this.backfillGroupStarted) {
      try {
        await this.d.redis.xgroup("CREATE", BACKFILL_KEY, "indexer", "0", "MKSTREAM");
      } catch (e) {
        if (!String((e as Error).message).includes("BUSYGROUP")) throw e;
      }
      this.backfillGroupStarted = true;
    }
    const args: (string | number)[] = ["GROUP", "indexer", "leader", "COUNT", 100];
    if (blockMs > 0) args.push("BLOCK", blockMs);
    const res = (await (this.d.redis as unknown as { xreadgroup(...a: (string | number)[]): Promise<unknown> })
      .xreadgroup(...args, "STREAMS", BACKFILL_KEY, ">")) as [string, [string, string[]][]][] | null;
    if (!res) return 0;
    let served = 0;
    for (const [, entries] of res) {
      for (const [id, fields] of entries) {
        const f = new Map<string, string>();
        for (let i = 0; i + 1 < fields.length; i += 2) f.set(fields[i]!, fields[i + 1]!);
        const m = f.get("market")!;
        let appended = 0;
        for (const s of await this.signaturesSince(m)) appended += await this.processSignature(s);
        if (appended > 0) await this.d.projector.rebuildMarket(m, await this.marketHistory(m));
        this.log.info?.("served backfill request", { market: m, from: f.get("from_seq"), to: f.get("to_seq"), appended });
        await this.d.redis.xack(BACKFILL_KEY, "indexer", id);
        served++;
      }
    }
    return served;
  }

  /**
   * Promotes signatures once the finalized slot passes them. A confirmed signature that is
   * not finalized there (dropped by a fork) gets a `Dropped` control entry, and the markets
   * it touched are rebuilt from history without it (IDX-05).
   */
  async checkFinality(): Promise<{ finalized: number; dropped: number }> {
    const fin = await this.d.source.getSlot("finalized");
    const due = [...this.pending].filter(([, v]) => v.slot <= fin);
    if (due.length === 0) return { finalized: 0, dropped: 0 };
    const statuses = await this.d.source.getSignatureStatuses(due.map(([s]) => s));
    let finalized = 0;
    const dropped: [string, { slot: number; markets: Set<string>; owners: Set<string> }][] = [];
    for (let i = 0; i < due.length; i++) {
      const [sig, v] = due[i]!;
      const st = statuses[i];
      if (st && !st.err && st.confirmationStatus === "finalized") {
        await this.d.stream.append({ type: "control", sig, slot: v.slot, kind: "Finalized", commitment: "finalized" });
        this.pending.delete(sig);
        finalized++;
      } else if (!st || st.err) {
        await this.d.stream.append({ type: "control", sig, slot: v.slot, kind: "Dropped", commitment: "confirmed" });
        this.pending.delete(sig);
        dropped.push([sig, v]);
      }
    }
    const gone = new Set(dropped.map(([s]) => s));
    const markets = new Set(dropped.flatMap(([, v]) => [...v.markets]));
    const owners = new Set(dropped.flatMap(([, v]) => [...v.owners]));
    for (const m of markets) await this.d.projector.rebuildMarket(m, await this.marketHistory(m, gone), owners);
    return { finalized, dropped: dropped.length };
  }
}
