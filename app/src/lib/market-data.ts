"use client";
/** Live market data hooks: tickers with `px:` prices, a strike list, and one book kept by seq. */
import { useCallback, useEffect, useRef, useState } from "react";
import { applyDelta, bestPrices, fromSnapshot, type BookDelta, type BookState } from "./book";
import { useChannel, useServices } from "./services";
import type { Market, Ticker } from "./types";

export function useTickers() {
  const { api } = useServices();
  const [tickers, setTickers] = useState<Ticker[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.tickers().then((r) => live && (setTickers(r.data), setError(null)), (e) => live && setError((e as Error).message));
    load();
    const t = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [api]);
  const onPx = useCallback((symbol: string, price: string, conf: string | null, publishTime: number | null) => {
    setTickers((ts) => ts?.map((t) => (t.symbol === symbol ? { ...t, underlying: { price, conf, publishTime: publishTime ? new Date(publishTime * 1000).toISOString() : t.underlying?.publishTime ?? null } } : t)) ?? ts);
  }, []);
  return { tickers, error, onPx };
}

/** Subscribes `px:{symbol}` and reports each `underlying` message (WS-06, at most 4 a second). */
export function usePx(symbol: string, onPx: (symbol: string, price: string, conf: string | null, publishTime: number | null) => void) {
  useChannel(`px:${symbol}`, (m) => {
    if (m.type === "underlying" && m.price != null) onPx(symbol, String(m.price), m.conf == null ? null : String(m.conf), typeof m.publish_time === "number" ? m.publish_time : null);
  });
}

export function useMarkets(symbol: string | null) {
  const { api } = useServices();
  const [data, setData] = useState<{ markets: Market[]; closeTimeUnix: number | null; tradingDate: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!symbol) return;
    let live = true;
    setData(null);
    api.markets(symbol).then(
      (r) => live && setData({ markets: r.markets, closeTimeUnix: r.closeTimeUnix, tradingDate: r.tradingDate }),
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [api, symbol]);
  return { data, error };
}

/**
 * One market's book in Yes terms (MER-72). The gateway sends a snapshot on subscribe, then
 * deltas; a delta whose `prev_seq` does not match is a gap and triggers a refetch.
 */
export function useBook(marketId: string | null) {
  const { api, rt } = useServices();
  const [book, setBook] = useState<BookState | null>(null);
  const ref = useRef<BookState | null>(null);
  const set = (b: BookState | null) => {
    ref.current = b;
    setBook(b);
  };

  const refetch = useCallback(async () => {
    if (!marketId) return;
    try {
      const s = await api.book(marketId, "YES");
      const b = fromSnapshot(s);
      if (!ref.current || b.seq >= ref.current.seq) set(b);
    } catch {
      /* the gateway snapshot will arrive */
    }
  }, [api, marketId]);

  useEffect(() => {
    set(null);
    void refetch();
  }, [refetch]);

  const channel = marketId ? `book:${marketId}` : null;
  useChannel(channel, (m) => {
    if (m.type === "book_snapshot") {
      set(fromSnapshot(m as unknown as { seq: string; bids: [number, number][]; asks: [number, number][] }));
      return;
    }
    if (m.type !== "book_delta" || !ref.current) return;
    const r = applyDelta(ref.current, m as unknown as BookDelta);
    if (r.kind === "applied") set(r.book);
    else if (r.kind === "gap") {
      rt.snapshot(channel!);
      void refetch();
    }
  });

  return { book, refetch };
}

/** Market fields with the live book's best prices folded in (yes/no quotes, implied probability). */
export function withLiveBook(m: Market, b: BookState | null): Market {
  if (!b) return m;
  const { bid, ask } = bestPrices(b);
  const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
  return {
    ...m,
    yes: { ...m.yes, bid, ask },
    no: { bid: ask != null ? 100 - ask : null, ask: bid != null ? 100 - bid : null },
    impliedProbability: mid != null ? mid / 100 : m.yes.last != null ? m.yes.last / 100 : null,
    seq: b.seq.toString(),
  };
}
