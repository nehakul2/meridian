/** Fakes shared by the automation tests: clock, vendors, Hermes and a Deps builder. */
import { Alerter, silentLogger } from "../../src/alerts.js";
import { buildCalendarYear, TradingCalendar } from "../../src/calendar.js";
import type { MeridianChain } from "../../src/chain/client.js";
import type { PriceUpdatePoster } from "../../src/chain/pyth.js";
import type { Deps } from "../../src/jobs/common.js";
import { MemoryKv } from "../../src/jobs/common.js";
import type { HermesApi, HermesUpdate } from "../../src/oracle/hermes.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { Clock, IsoDate } from "../../src/time.js";
import type { IvSnapshot, IvSource, OfficialCloseQuote, OfficialCloseSource } from "../../src/vendors/massive.js";
import { feedHex, MAG7, priceUpdateBytes } from "./svm.js";

export class FakeClock implements Clock {
  readonly sleeps: number[] = [];
  constructor(public t: number) {}
  now() {
    return this.t;
  }
  /** Lets every other pending task run first, then jumps the clock (parallel tickers stay ordered). */
  async sleep(s: number) {
    this.sleeps.push(s);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    this.t += Math.max(0, Math.round(s));
  }
}

/** Official close per (symbol, date), published from `at` (unix s) onwards. */
export class FakeCloseSource implements OfficialCloseSource {
  readonly calls: { symbol: string; date: IsoDate; t: number }[] = [];
  readonly values = new Map<string, { cents: bigint; at: number }>();
  failWith: Error | null = null;
  constructor(readonly name: "MASSIVE" | "DATABENTO", private readonly clock: Clock) {}
  set(symbol: string, date: IsoDate, cents: bigint, at = 0) {
    this.values.set(`${symbol}|${date}`, { cents, at });
  }
  async officialClose(symbol: string, date: IsoDate): Promise<OfficialCloseQuote | null> {
    this.calls.push({ symbol, date, t: this.clock.now() });
    if (this.failWith) throw this.failWith;
    const v = this.values.get(`${symbol}|${date}`);
    if (!v || this.clock.now() < v.at) return null;
    return { cents: v.cents, raw: {} };
  }
}

/** Hermes with a list of updates per feed; returns the first at or after the target that is visible "now". */
export class FakeHermes implements HermesApi {
  readonly calls: { feed: string; target: number; t: number }[] = [];
  readonly updates = new Map<string, (HermesUpdate & { visibleAt: number })[]>();
  failWith: Error | null = null;
  constructor(private readonly clock: Clock) {}
  add(symbol: string, u: { price: bigint; conf: bigint; expo?: number; publishTime: number; visibleAt?: number; partial?: boolean }) {
    const feed = feedHex(symbol);
    const expo = u.expo ?? -5;
    const list = this.updates.get(feed) ?? [];
    list.push({
      publishTime: u.publishTime, priceRaw: u.price, expo, conf: u.conf, visibleAt: u.visibleAt ?? 0,
      vaa: priceUpdateBytes({ feed: Buffer.from(feed, "hex"), price: u.price, conf: u.conf, expo, publishTime: u.publishTime, partial: u.partial }),
    });
    list.sort((a, b) => a.publishTime - b.publishTime);
    this.updates.set(feed, list);
  }
  async updateAtOrAfter(feed: string, target: number) {
    this.calls.push({ feed, target, t: this.clock.now() });
    if (this.failWith) throw this.failWith;
    const u = (this.updates.get(feed) ?? []).find((x) => x.publishTime >= target && x.visibleAt <= this.clock.now());
    return u ?? null;
  }
}

export class FakeIv implements IvSource {
  readonly values = new Map<string, bigint>();
  async atmImpliedVol(symbol: string, _date: IsoDate, prev: bigint): Promise<IvSnapshot | null> {
    const v = this.values.get(symbol);
    return v === undefined ? null : { ivBps: v, expiry: "2026-11-27", strikeCents: prev, source: "fake" };
  }
}

export function calendar2026(): TradingCalendar {
  return new TradingCalendar([...buildCalendarYear(2025), ...buildCalendarYear(2026), ...buildCalendarYear(2027)]);
}

export function mag7Store(clock: Clock): MemoryStore {
  const s = new MemoryStore(() => clock.now());
  s.tickers = MAG7.map((symbol) => ({ symbol, pythFeedId: feedHex(symbol), liquidityTierOverride: null, enabled: true }));
  return s;
}

export function makeDeps(p: {
  clock: FakeClock;
  chain: MeridianChain;
  poster?: PriceUpdatePoster | null;
  store?: MemoryStore;
}) {
  const store = p.store ?? mag7Store(p.clock);
  const massive = new FakeCloseSource("MASSIVE", p.clock);
  const databento = new FakeCloseSource("DATABENTO", p.clock);
  const hermes = new FakeHermes(p.clock);
  const iv = new FakeIv();
  const kv = new MemoryKv();
  const deps: Deps = {
    store, chain: p.chain, calendar: calendar2026(), clock: p.clock, log: silentLogger,
    alerter: new Alerter(store, silentLogger), hermes, closes: { massive, databento }, iv, corp: null,
    poster: p.poster ?? null, alt: null, kv,
  };
  return { deps, store, massive, databento, hermes, iv, kv };
}
