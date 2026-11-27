/** Shared job plumbing: dependencies, retry/backoff and the Redis-like key store. */
import type { PublicKey } from "@solana/web3.js";
import type { Alerter, Logger } from "../alerts.js";
import type { CorporateActionFeed, TradingCalendar } from "../calendar.js";
import type { MeridianChain } from "../chain/client.js";
import type { PriceUpdatePoster } from "../chain/pyth.js";
import type { HermesApi } from "../oracle/hermes.js";
import type { CloseSources } from "../oracle/officialClose.js";
import type { Store } from "../store/types.js";
import type { Clock } from "../time.js";
import type { IvSource } from "../vendors/massive.js";

/** The Redis keys Automation writes (spec 6.1: `md:alt:{t}:{d}` only). */
export interface KeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlS: number): Promise<void>;
}

export class MemoryKv implements KeyValue {
  readonly map = new Map<string, string>();
  async get(k: string) {
    return this.map.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.map.set(k, v);
  }
}

/** Address Lookup Table for one ticker-day's market accounts (spec 8 MORNING). */
export interface AltManager {
  create(addresses: PublicKey[]): Promise<{ table: PublicKey; sigs: string[] }>;
}

export interface Deps {
  store: Store;
  chain: MeridianChain;
  calendar: TradingCalendar;
  clock: Clock;
  log: Logger;
  alerter: Alerter;
  hermes: HermesApi;
  closes: CloseSources;
  iv: IvSource | null;
  corp: CorporateActionFeed | null;
  poster: PriceUpdatePoster | null;
  alt: AltManager | null;
  kv: KeyValue | null;
}

/** Capped exponential backoff with ±20% jitter (deterministic when `rand` is fixed). */
export function backoffS(attempt: number, baseS: number, capS: number, rand: () => number = Math.random): number {
  const raw = Math.min(capS, baseS * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.round(raw * (0.8 + 0.4 * rand())));
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
