"use client";
/** MER-71: ticker grid with live underlying prices, and the strike ladder as contract cards. */
import Link from "next/link";
import { useEffect, useState } from "react";
import { change, cents, etTime, pct, price } from "@/lib/format";
import { useServerNow, useStatus } from "@/lib/status";
import { useBook, useMarkets, usePx, useTickers, withLiveBook } from "@/lib/market-data";
import type { Market, Ticker } from "@/lib/types";
import { Countdown } from "./Countdown";

/** A price older than this (on the server clock) is flagged stale (FE-05). */
export const STALE_MS = 60_000;

function TickerCard({ t, active, onSelect, onPx }: { t: Ticker; active: boolean; onSelect?: (s: string) => void; onPx: Parameters<typeof usePx>[1] }) {
  usePx(t.symbol, onPx);
  const now = useServerNow(5000);
  const { synced } = useStatus();
  const pub = t.underlying?.publishTime ? Date.parse(t.underlying.publishTime) : null;
  const stale = synced && pub !== null && now - pub > STALE_MS;
  const ch = change(t.underlying?.price, t.prevClose);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const [last, setLast] = useState(t.underlying?.price);
  useEffect(() => {
    const p = t.underlying?.price;
    if (p && last && p !== last) {
      setFlash(Number(p) > Number(last) ? "up" : "down");
      const x = setTimeout(() => setFlash(null), 600);
      setLast(p);
      return () => clearTimeout(x);
    }
    setLast(p);
  }, [t.underlying?.price]); // eslint-disable-line react-hooks/exhaustive-deps
  const body = (
    <>
      <div className="ticker-top">
        <span className="ticker-sym">{t.symbol}</span>
        <span className="muted small">{t.activeMarkets} {t.activeMarkets === 1 ? "contract" : "contracts"}</span>
      </div>
      <div className={`ticker-px mono${flash ? ` flash-${flash}` : ""}`} data-testid={`px-${t.symbol}`}>{t.underlying ? price(t.underlying.price) : "—"}</div>
      <div className={`small ${ch ? `chg-${ch.dir}` : "muted"}`}>{ch ? ch.text : t.underlying ? "vs prev close —" : "Price feed offline"}</div>
      {pub !== null ? (
        <div className="tiny muted ticker-asof" data-testid={`asof-${t.symbol}`}>
          {stale ? <span className="stale" data-testid={`stale-${t.symbol}`}>Stale</span> : null} as of {etTime(new Date(pub).toISOString(), true)}
        </div>
      ) : null}
    </>
  );
  return onSelect ? (
    <button className={`ticker-card${active ? " active" : ""}`} onClick={() => onSelect(t.symbol)} data-testid={`ticker-${t.symbol}`} aria-pressed={active}>
      {body}
    </button>
  ) : (
    <Link className="ticker-card" href={`/markets/?t=${t.symbol}`} data-testid={`ticker-${t.symbol}`}>{body}</Link>
  );
}

export function TickerGrid({ selected, onSelect }: { selected?: string | null; onSelect?: (s: string) => void }) {
  const { tickers, error, onPx } = useTickers();
  if (error && !tickers) return <div className="empty">Couldn't load tickers: {error}</div>;
  if (!tickers) return <div className="ticker-grid">{Array.from({ length: 7 }, (_, i) => <div key={i} className="ticker-card skeleton" />)}</div>;
  return (
    <div className="ticker-grid" data-testid="ticker-grid">
      {tickers.map((t) => <TickerCard key={t.symbol} t={t} active={t.symbol === selected} onSelect={onSelect} onPx={onPx} />)}
    </div>
  );
}

export function ContractCard({ m }: { m: Market }) {
  const tradable = m.status === "TRADING";
  const prob = m.impliedProbability;
  return (
    <div className={`contract-card${m.status === "SETTLED" ? " settled" : ""}`} data-testid={`contract-${m.strikeCents}`}>
      <div className="contract-head">
        <div>
          <div className="contract-strike mono">${m.strike}</div>
          <div className="contract-q">{m.symbol} closes at or above ${m.strike}</div>
        </div>
        <div className="prob" title="Implied probability from the order book mid">
          <div className="prob-val" data-testid="implied">{pct(prob)}</div>
          <div className="muted tiny">chance</div>
        </div>
      </div>
      <div className="prob-bar"><span style={{ width: `${prob == null ? 0 : Math.round(prob * 100)}%` }} /></div>
      {m.status === "SETTLED" ? (
        <div className="contract-settled">
          Settled <strong className={m.outcome === "YES" ? "yes" : "no"}>{m.outcome}</strong>
        </div>
      ) : (
        <div className="contract-prices">
          <Link className={`quote quote-yes${tradable ? "" : " disabled"}`} href={`/trade/?m=${m.marketId}&intent=BUY_YES`} data-testid="buy-yes">
            <span>Buy Yes</span>
            <span className="mono" data-testid="yes-ask">{cents(m.yes.ask)}</span>
          </Link>
          <Link className={`quote quote-no${tradable ? "" : " disabled"}`} href={`/trade/?m=${m.marketId}&intent=BUY_NO`} data-testid="buy-no">
            <span>Buy No</span>
            <span className="mono" data-testid="no-ask">{cents(m.no.ask)}</span>
          </Link>
        </div>
      )}
      <div className="contract-foot muted tiny">
        <span>Yes bid {cents(m.yes.bid)} · No bid {cents(m.no.bid)}</span>
        <span>Vol {m.volume.toLocaleString("en-US")}</span>
      </div>
    </div>
  );
}

function LiveContractCard({ m }: { m: Market }) {
  const { book } = useBook(m.marketId);
  return <ContractCard m={withLiveBook(m, book)} />;
}

export function StrikeLadder({ symbol }: { symbol: string }) {
  const { data, error } = useMarkets(symbol);
  if (error) return <div className="empty">Couldn't load {symbol} contracts: {error}</div>;
  if (!data) return <div className="contract-grid">{Array.from({ length: 6 }, (_, i) => <div key={i} className="contract-card skeleton" />)}</div>;
  if (data.markets.length === 0) return <div className="empty">No {symbol} contracts listed for {data.tradingDate} yet. Strikes are created before the open.</div>;
  return (
    <section>
      <div className="section-head">
        <h2>{symbol} · {data.tradingDate}</h2>
        <Countdown closeTimeUnix={data.closeTimeUnix} />
      </div>
      <p className="muted small">Each contract pays $1.00 to Yes if {symbol}'s official close is at or above the strike, otherwise $1.00 to No.</p>
      <div className="contract-grid" data-testid="contract-grid">
        {data.markets.map((m) => <LiveContractCard key={m.marketId} m={m} />)}
      </div>
    </section>
  );
}

export function MarketsView({ initial }: { initial?: string | null }) {
  const [sym, setSym] = useState<string | null>(initial ?? null);
  useEffect(() => {
    if (initial) setSym(initial);
  }, [initial]);
  const selected = sym ?? "AAPL";
  return (
    <div>
      <div className="page-head">
        <h1>Markets</h1>
        <p className="muted">Daily binary contracts on the Magnificent 7. Pick a ticker to see today's strikes.</p>
      </div>
      <TickerGrid selected={selected} onSelect={(s) => {
        setSym(s);
        window.history.replaceState(null, "", `/markets/?t=${s}`);
      }} />
      <StrikeLadder symbol={selected} />
    </div>
  );
}
