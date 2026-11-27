/**
 * The two chain inputs a transaction needs that Redis does not hold: a recent blockhash
 * and the contents of the ticker-day Address Lookup Table. Both are refreshed in the
 * background, so the request path never waits on RPC (Tx Builder p99 < 30 ms, spec 3.3).
 */
import { AddressLookupTableAccount, Connection, PublicKey } from "@solana/web3.js";
import type { Redis } from "ioredis";
import { K } from "../../shared/src/keys.js";

export interface RecentBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface BlockhashSource {
  /** null when no fresh blockhash is known (the route answers 503 UNAVAILABLE). */
  get(): RecentBlockhash | null;
}

export interface AltSource {
  /** The ticker-day ALT if its contents are cached, else null (the tx is built without it). */
  get(symbol: string, date: number): AddressLookupTableAccount | null;
}

export const noAlts: AltSource = { get: () => null };

/** Polls `getLatestBlockhash(confirmed)` every `intervalMs`; stale after `maxAgeMs`. */
export class RpcBlockhashCache implements BlockhashSource {
  private cur: (RecentBlockhash & { at: number }) | null = null;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly conn: Connection, private readonly o: { intervalMs?: number; maxAgeMs?: number } = {}) {}

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.o.intervalMs ?? 2_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh() {
    try {
      const b = await this.conn.getLatestBlockhash("confirmed");
      this.cur = { ...b, at: Date.now() };
    } catch {
      /* keep the last one until it goes stale */
    }
  }

  get(): RecentBlockhash | null {
    if (!this.cur || Date.now() - this.cur.at > (this.o.maxAgeMs ?? 30_000)) return null;
    return { blockhash: this.cur.blockhash, lastValidBlockHeight: this.cur.lastValidBlockHeight };
  }
}

/**
 * ALT contents keyed by ticker-day. The table address comes from `md:alt:{t}:{d}`
 * (written by Automation's morning job); its addresses are read once over RPC in the
 * background and kept, since the table is only extended when the morning job builds it.
 */
export class RpcAltCache implements AltSource {
  private readonly tables = new Map<string, AddressLookupTableAccount>();
  private readonly loading = new Set<string>();
  constructor(private readonly conn: Connection, private readonly redis: Redis) {}

  get(symbol: string, date: number): AddressLookupTableAccount | null {
    const k = `${symbol}:${date}`;
    const t = this.tables.get(k);
    if (t) return t;
    if (!this.loading.has(k)) {
      this.loading.add(k);
      void this.load(symbol, date).finally(() => this.loading.delete(k));
    }
    return null;
  }

  private async load(symbol: string, date: number) {
    const addr = await this.redis.get(K.alt(symbol, date));
    if (!addr) return;
    const res = await this.conn.getAddressLookupTable(new PublicKey(addr), { commitment: "confirmed" });
    if (res.value) this.tables.set(`${symbol}:${date}`, res.value);
  }
}
