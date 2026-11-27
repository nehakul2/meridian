"use client";
/** Trade page: market header, the book in either view, recent trades, the trade panel and your orders here. */
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { explorerTx } from "@/lib/config";
import { cents, etTime, INTENT_LABEL, pct } from "@/lib/format";
import { useBook, withLiveBook } from "@/lib/market-data";
import { useChannel, useServices } from "@/lib/services";
import { signSendConfirm, type TxPhase } from "@/lib/tx";
import type { Intent, MarketDetail, Order, Position, Trade, View } from "@/lib/types";
import { notifyTxConfirmed, useUserResource } from "@/lib/user";
import { Countdown } from "./Countdown";
import { OrderBook, useDefaultView } from "./OrderBook";
import { TradePanel, TxStatus } from "./TradePanel";

function RecentTrades({ marketId, view }: { marketId: string; view: View }) {
  const { api } = useServices();
  const [trades, setTrades] = useState<Trade[]>([]);
  useEffect(() => {
    let live = true;
    api.trades(marketId, 20).then((r) => live && setTrades(r.data), () => undefined);
    return () => {
      live = false;
    };
  }, [api, marketId]);
  useChannel(`trades:${marketId}`, (m) => {
    if (m.type !== "trade") return;
    const t: Trade = { seq: String(m.seq), priceCents: Number(m.price), noPriceCents: 100 - Number(m.price), qty: Number(m.qty), takerSide: String(m.taker_side), time: typeof m.ts === "number" ? new Date(m.ts * 1000).toISOString() : null, signature: "" };
    setTrades((ts) => [t, ...ts.filter((x) => x.seq !== t.seq)].slice(0, 20));
  });
  return (
    <div className="card">
      <div className="card-head"><h3>Recent trades</h3><span className="muted tiny">{view === "YES" ? "Yes" : "No"} prices</span></div>
      {trades.length === 0 ? <div className="empty small">No trades yet today.</div> : (
        <table className="table compact" data-testid="recent-trades">
          <thead><tr><th>Time</th><th>Price</th><th>Qty</th></tr></thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t.seq}>
                <td className="muted">{t.time ? etTime(t.time).replace(" ET", "") : "—"}</td>
                <td className="mono">{view === "YES" ? t.priceCents : t.noPriceCents}¢</td>
                <td className="mono">{t.qty}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function MyOrders({ orders, marketId, onDone }: { orders: Order[]; marketId: string; onDone: () => void }) {
  const { api, rpc, config } = useServices();
  const { publicKey, signTransaction } = useWallet();
  const [phase, setPhase] = useState<TxPhase>({ kind: "idle" });
  const mine = orders.filter((o) => o.marketId === marketId);
  if (mine.length === 0) return null;
  async function cancel(orderId?: string) {
    if (!publicKey) return;
    setPhase({ kind: "building" });
    try {
      const r = await api.txCancel({ owner: publicKey.toBase58(), marketId, ...(orderId ? { orderId } : { all: true }) });
      const end = await signSendConfirm(r, signTransaction, rpc, setPhase);
      if (end.kind === "confirmed") {
        notifyTxConfirmed();
        onDone();
      }
    } catch (e) {
      setPhase({ kind: "failed", message: (e as Error).message });
    }
  }
  return (
    <div className="card" data-testid="my-orders">
      <div className="card-head"><h3>Your open orders</h3>{mine.length > 1 ? <button className="btn btn-sm" onClick={() => void cancel()}>Cancel all</button> : null}</div>
      <table className="table compact">
        <thead><tr><th>Order</th><th>Price</th><th>Filled</th><th /></tr></thead>
        <tbody>
          {mine.map((o) => (
            <tr key={o.orderId}>
              <td>{INTENT_LABEL[o.intent]}{o.intent === "BUY_NO" ? <span className="tag tag-dim">pending</span> : null}</td>
              <td className="mono">{o.priceCents}¢</td>
              <td className="mono">{o.filled}/{o.qty}</td>
              <td><button className="link small" onClick={() => void cancel(o.orderId)}>Cancel</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <TxStatus phase={phase} explorer={(s) => explorerTx(s, config)} />
    </div>
  );
}

export function TradeView({ marketId, intent }: { marketId: string | null; intent?: Intent }) {
  const { api } = useServices();
  const auth = useAuth();
  const [market, setMarket] = useState<MarketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { book } = useBook(marketId);
  const [view, setView] = useDefaultView();
  const [picked, setPicked] = useState<{ price: number; at: number; intent: Intent } | null>(null);

  useEffect(() => {
    if (!marketId) return;
    let live = true;
    api.market(marketId).then((m) => live && setMarket(m), (e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [api, marketId]);

  useChannel(marketId ? `market:${marketId}` : null, (m) => {
    if (m.type === "market_status") setMarket((x) => (x ? { ...x, status: m.status as MarketDetail["status"], outcome: (m.outcome as MarketDetail["outcome"]) ?? x.outcome } : x));
    if (m.type === "book_closed") setMarket((x) => (x && x.status === "TRADING" ? { ...x, status: "HALTED" } : x));
  });

  const positions = useUserResource((t) => api.positions(t, "ALL"));
  const orders = useUserResource((t) => api.orders(t, "OPEN", marketId ?? undefined));
  const prefs = useUserResource((t) => api.prefs(t));

  if (!marketId) return <div className="empty">Pick a contract on the <Link href="/markets/">markets page</Link>.</div>;
  if (error) return <div className="empty">Couldn't load this contract: {error}</div>;
  if (!market) return <div className="empty">Loading…</div>;

  const live = withLiveBook(market, book);
  const pos: Position | null | undefined = positions.data ? positions.data.data.find((p) => p.marketId === marketId) ?? null : undefined;

  return (
    <div className="trade-page">
      <div className="market-head">
        <div>
          <Link href={`/markets/?t=${market.symbol}`} className="muted small">← {market.symbol} contracts</Link>
          <h1 className="market-title">{market.question}</h1>
          <div className="market-meta small muted">
            <span>Strike <strong className="mono">${market.strike}</strong></span>
            <span>Closes {market.closeTimeUnix ? etTime(market.closeTimeUnix) : "—"}</span>
            <span>Volume {market.volume.toLocaleString("en-US")}</span>
            <span className={`status status-${live.status.toLowerCase()}`}>{live.status === "SETTLED" ? `Settled ${live.outcome}` : live.status.replace("_", " ").toLowerCase()}</span>
          </div>
        </div>
        <div className="market-stats">
          <div className="stat"><div className="muted tiny">Chance</div><div className="stat-big">{pct(live.impliedProbability)}</div></div>
          <div className="stat"><div className="muted tiny">Yes</div><div className="stat-big yes mono">{cents(live.yes.ask)}</div></div>
          <div className="stat"><div className="muted tiny">No</div><div className="stat-big no mono">{cents(live.no.ask)}</div></div>
          <div className="stat"><div className="muted tiny">Time left</div><div className="stat-big"><Countdown closeTimeUnix={market.closeTimeUnix} compact /></div></div>
        </div>
      </div>
      <div className="trade-grid">
        <div className="trade-left">
          <OrderBook book={book} view={view} onViewChange={setView} onPick={(p, side) => {
            const i: Intent = view === "YES" ? (side === "ask" ? "BUY_YES" : "SELL_YES") : side === "ask" ? "BUY_NO" : "SELL_NO";
            setPicked({ price: p, at: Date.now(), intent: i });
          }} />
          <RecentTrades marketId={marketId} view={view} />
        </div>
        <div className="trade-right">
          <TradePanel market={live} position={pos} slippageCents={prefs.data?.slippageCents ?? 2} initialIntent={intent ?? "BUY_YES"} pickedPrice={picked} />
          {auth.status === "signed_in" && orders.data ? <MyOrders orders={orders.data.data} marketId={marketId} onDone={() => void orders.reload()} /> : null}
        </div>
      </div>
    </div>
  );
}
