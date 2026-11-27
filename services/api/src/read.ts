/**
 * Redis readers for the hot routes (spec 6.1). Every function here is one pipeline of
 * GET / HGETALL / ZRANGE calls; nothing touches RPC (API-10) and nothing writes.
 */
import type { Redis } from "ioredis";
import { K } from "../../shared/src/keys.js";
import {
  centsToDollars, closesAtOrAbove, iso, marketStatus, MarketView, question,
} from "../../shared/src/market.js";

export interface MarketRow {
  marketId: string;
  symbol: string;
  date: number;
  strikeCents: bigint;
  chainStatus: string;
  outcome: string | null;
  yesMint: string;
  noMint: string;
  vault: string;
  book: string;
  tickerDay: string;
  openTime: number;
  closeTime: number;
  mintOpenTime: number;
  pairsOutstanding: number;
  volume: number;
  lastCents: number | null;
  seq: string;
  settlePrice: string | null;
  bbo: Record<string, string>;
}

const n = (s: string | undefined) => (s ? Number(s) : 0);

export async function readMarkets(redis: Redis, ids: string[]): Promise<(MarketRow | null)[]> {
  if (ids.length === 0) return [];
  const p = redis.pipeline();
  for (const m of ids) {
    p.hgetall(K.mkt(m));
    p.hgetall(K.bbo(m));
  }
  const res = (await p.exec())!;
  const rows = ids.map((m, i) => {
    const h = res[2 * i]![1] as Record<string, string>;
    if (!h || !h.symbol) return null;
    return {
      marketId: m,
      symbol: h.symbol,
      date: Number(h.date),
      strikeCents: BigInt(h.strike_cents ?? "0"),
      chainStatus: h.status ?? "TRADING",
      outcome: h.outcome ? h.outcome : null,
      yesMint: h.yes_mint ?? "",
      noMint: h.no_mint ?? "",
      vault: h.vault ?? "",
      book: h.book ?? "",
      tickerDay: h.ticker_day ?? "",
      openTime: n(h.open_time),
      closeTime: n(h.close_time),
      mintOpenTime: 0,
      pairsOutstanding: n(h.pairs_outstanding),
      volume: n(h.volume),
      lastCents: h.last_cents ? Number(h.last_cents) : null,
      seq: h.seq ?? "0",
      settlePrice: h.settle_price ?? null,
      bbo: (res[2 * i + 1]![1] as Record<string, string>) ?? {},
    } satisfies MarketRow;
  });
  // mint_open_time lives on the ticker-day (one read per distinct ticker-day).
  const tdays = [...new Set(rows.filter((r) => r).map((r) => `${r!.symbol}:${r!.date}`))];
  if (tdays.length > 0) {
    const q = redis.pipeline();
    for (const t of tdays) {
      const [s, d] = t.split(":") as [string, string];
      q.hmget(K.tday(s, d), "mint_open_time", "open_time", "close_time");
    }
    const tr = (await q.exec())!;
    const times = new Map(tdays.map((t, i) => [t, tr[i]![1] as (string | null)[]]));
    for (const r of rows) {
      if (!r) continue;
      const [mo, o, c] = times.get(`${r.symbol}:${r.date}`) ?? [];
      r.mintOpenTime = n(mo ?? undefined);
      if (!r.openTime) r.openTime = n(o ?? undefined);
      if (!r.closeTime) r.closeTime = n(c ?? undefined);
    }
  }
  return rows;
}

export function viewStatus(r: MarketRow, now: number): MarketView {
  return marketStatus(r.chainStatus, now, { mintOpenTime: r.mintOpenTime, openTime: r.openTime, closeTime: r.closeTime });
}

const num = (s: string | undefined) => (s === undefined || s === "" ? null : Number(s));

/** Market JSON for lists and the market route (spec 7.2). */
export function marketJson(r: MarketRow, now: number) {
  const bid = num(r.bbo.bid);
  const ask = num(r.bbo.ask);
  const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
  const implied = mid != null ? mid / 100 : r.lastCents != null ? r.lastCents / 100 : null;
  return {
    marketId: r.marketId,
    symbol: r.symbol,
    tradingDate: `${String(r.date).slice(0, 4)}-${String(r.date).slice(4, 6)}-${String(r.date).slice(6, 8)}`,
    strike: centsToDollars(r.strikeCents),
    strikeCents: Number(r.strikeCents),
    question: question(r.symbol, r.strikeCents),
    status: viewStatus(r, now),
    outcome: r.outcome,
    // A19: Buy No costs 100 − best Yes bid; Sell No receives 100 − best Yes ask.
    yes: { bid, ask, last: r.lastCents },
    no: { bid: ask != null ? 100 - ask : null, ask: bid != null ? 100 - bid : null },
    impliedProbability: implied, // from the book (D14), never from external IV
    volume: r.volume,
    pairsOutstanding: r.pairsOutstanding,
    yesMint: r.yesMint,
    noMint: r.noMint,
    openTime: r.openTime ? iso(r.openTime) : null,
    closeTime: r.closeTime ? iso(r.closeTime) : null,
    closeTimeUnix: r.closeTime || null,
    seq: r.seq,
  };
}

export interface TdayRow {
  symbol: string;
  date: number;
  status: string;
  closePrice: string | null;
  closePriceRaw: bigint | null;
  expo: number | null;
  publishTime: number | null;
  recordedBy: string | null;
  override: boolean;
  recordedAt: number | null;
  finalAtEst: number | null;
  finalAt: number | null;
  dispute: Record<string, unknown> | null;
  disputeResult: string | null;
  originalPriceRaw: string | null;
  openTime: number;
  closeTime: number;
  mintOpenTime: number;
}

export async function readTdays(redis: Redis, symbols: string[], date: number): Promise<(TdayRow | null)[]> {
  const p = redis.pipeline();
  for (const s of symbols) p.hgetall(K.tday(s, date));
  const res = (await p.exec())!;
  return symbols.map((s, i) => {
    const h = res[i]![1] as Record<string, string>;
    if (!h || Object.keys(h).length === 0) return null;
    return {
      symbol: s, date, status: h.status || "OPEN",
      closePrice: h.close_price || null, closePriceRaw: h.close_price_raw ? BigInt(h.close_price_raw) : null,
      expo: h.expo ? Number(h.expo) : null, publishTime: h.publish_time ? Number(h.publish_time) : null,
      recordedBy: h.recorded_by || null, override: h.override === "1",
      recordedAt: h.recorded_at ? Number(h.recorded_at) : null, finalAtEst: h.final_at_est ? Number(h.final_at_est) : null,
      finalAt: h.final_at ? Number(h.final_at) : null,
      dispute: h.dispute ? (JSON.parse(h.dispute) as Record<string, unknown>) : null,
      disputeResult: h.dispute_result || null, originalPriceRaw: h.original_price_raw || null,
      openTime: n(h.open_time), closeTime: n(h.close_time), mintOpenTime: n(h.mint_open_time),
    };
  });
}

/** Outcome as known now: the chain's once settled, else the provisional one from the recorded close. */
export function knownOutcome(m: MarketRow, td: TdayRow | null): { outcome: string | null; provisional: boolean } {
  if (m.chainStatus === "SETTLED" || m.chainStatus === "VOID") return { outcome: m.outcome, provisional: false };
  if (td && td.closePriceRaw != null && td.expo != null && td.status !== "OPEN") {
    return { outcome: closesAtOrAbove(td.closePriceRaw, td.expo, m.strikeCents) ? "YES" : "NO", provisional: true };
  }
  return { outcome: null, provisional: false };
}

export async function marketIdsFor(redis: Redis, symbol: string, date: number): Promise<string[]> {
  return redis.zrange(K.dayStrikes(date, symbol), 0, -1);
}

export interface Cfg {
  paused: boolean;
  feeBps: number;
  overrideDelayS: number;
  maxQtyPerTrade: number;
  disputeWindowS: number;
}

export async function readCfg(redis: Redis): Promise<Cfg> {
  const h = await redis.hgetall(K.cfg);
  return {
    paused: h.paused === "1",
    feeBps: n(h.fee_bps),
    overrideDelayS: h.override_delay_s ? Number(h.override_delay_s) : 1800,
    maxQtyPerTrade: h.max_qty_per_trade ? Number(h.max_qty_per_trade) : 500,
    disputeWindowS: h.dispute_window_s ? Number(h.dispute_window_s) : 1200,
  };
}
