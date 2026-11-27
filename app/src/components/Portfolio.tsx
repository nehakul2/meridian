"use client";
/**
 * MER-74: positions with P&L, settled contracts with close price and outcome, redeem (one
 * transaction per batch) and claim (withdraw ledger proceeds), and the maker view.
 */
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { explorerTx } from "@/lib/config";
import { cents, INTENT_LABEL, price, usd } from "@/lib/format";
import { useServices } from "@/lib/services";
import { signSendConfirm, type TxPhase } from "@/lib/tx";
import type { Claimable, Order, Position, TxResponse } from "@/lib/types";
import { notifyTxConfirmed, useUsdcBalance, useUserResource } from "@/lib/user";
import { TxStatus } from "./TradePanel";

/** Markets per redeem request (the Tx Builder accepts up to 50 and splits them into transactions that fit). */
export const REDEEM_MAX = 50;

export function sideLabel(p: Position): string {
  switch (p.side) {
    case "BOTH_PENDING": return "Buy No pending";
    case "BOTH": return "Yes + No";
    case "FLAT": return "Closed";
    default: return p.side;
  }
}

const pnlClass = (s: string) => (BigInt(s) > 0n ? "pos" : BigInt(s) < 0n ? "neg" : "");

function ConnectPrompt() {
  return (
    <div className="empty big-empty">
      <h2>Connect a wallet to see your portfolio</h2>
      <p className="muted">Positions, P&L, claims and redemptions show up here once you connect and sign in.</p>
    </div>
  );
}

export function SignInPrompt() {
  const auth = useAuth();
  return (
    <div className="empty big-empty" data-testid="signin-prompt">
      <h2>Sign in to view your positions</h2>
      <p className="muted">Sign a message with your wallet. It costs nothing and sends no transaction.</p>
      <button className="btn btn-primary" onClick={() => void auth.ensureToken().catch(() => undefined)} disabled={auth.status === "signing"} data-testid="signin">
        {auth.status === "signing" ? "Check your wallet…" : auth.status === "rejected" ? "Try again" : "Sign in"}
      </button>
      {auth.error ? <p className="small warn-text">{auth.error}</p> : null}
    </div>
  );
}

function useClosePrices(positions: Position[] | undefined) {
  const { api } = useServices();
  const [map, setMap] = useState<Record<string, { closePrice: string | null; provisional: boolean }>>({});
  const settledIds = useMemo(() => (positions ?? []).filter((p) => p.status === "SETTLED" || p.status === "VOID").map((p) => p.marketId).sort().join(","), [positions]);
  useEffect(() => {
    if (!settledIds) return;
    let live = true;
    (async () => {
      const ids = settledIds.split(",");
      const details = await Promise.all(ids.map((id) => api.market(id).catch(() => null)));
      const dates = [...new Set(details.filter(Boolean).map((d) => d!.tradingDate))];
      const sets = await Promise.all(dates.map((d) => api.settlements(d).catch(() => null)));
      const out: Record<string, { closePrice: string | null; provisional: boolean }> = {};
      for (const s of sets) for (const t of s?.tickers ?? []) for (const m of t.markets) out[m.marketId] = { closePrice: t.closePrice, provisional: m.provisional };
      if (live) setMap(out);
    })();
    return () => {
      live = false;
    };
  }, [api, settledIds]);
  return map;
}

export function PortfolioView() {
  const { api, rpc, config } = useServices();
  const { connected, publicKey, signTransaction } = useWallet();
  const auth = useAuth();
  const positions = useUserResource((t) => api.positions(t, "ALL"), { prompt: true });
  const claimable = useUserResource((t) => api.claimable(t));
  const openOrders = useUserResource((t) => api.orders(t, "OPEN"));
  const allOrders = useUserResource((t) => api.orders(t, "ALL"));
  const { micro } = useUsdcBalance();
  const [tab, setTab] = useState<"positions" | "maker">("positions");
  const [phase, setPhase] = useState<TxPhase>({ kind: "idle" });
  const [progress, setProgress] = useState<string | null>(null);
  const closes = useClosePrices(positions.data?.data);

  if (!connected || !publicKey) return <ConnectPrompt />;
  if (auth.status !== "signed_in") return <SignInPrompt />;
  if (!positions.data) return <div className="empty">{positions.error ? `Couldn't load positions: ${positions.error}` : "Loading positions…"}</div>;

  const owner = publicKey.toBase58();
  const all = positions.data.data;
  const open = all.filter((p) => p.status !== "SETTLED" && p.status !== "VOID" && p.side !== "FLAT");
  const settled = all.filter((p) => p.status === "SETTLED" || p.status === "VOID");
  const sum = (xs: string[]) => xs.reduce((a, x) => a + BigInt(x), 0n);
  const unreal = sum(open.map((p) => p.unrealizedPnl));
  const real = sum(all.map((p) => p.realizedPnl));
  const c: Claimable | null = claimable.data;
  const ledgerRows = (c?.data ?? []).filter((r) => BigInt(r.ledger.freeUsdc) > 0n || r.ledger.freeYes > 0);
  const redeemIds = settled.filter((p) => BigInt(p.redeemable) > 0n && !p.redeemed).map((p) => p.marketId);
  const busy = phase.kind === "building" || phase.kind === "signing" || phase.kind === "pending";

  /** Signs and sends each transaction in turn (one wallet approval per transaction), stopping at the first that does not confirm. */
  async function sendAll(label: string, txs: { transaction: string; lastValidBlockHeight: number }[]): Promise<boolean> {
    for (const [i, t] of txs.entries()) {
      setProgress(txs.length > 1 ? `${label} ${i + 1} of ${txs.length}` : null);
      const end = await signSendConfirm({ ...t, summary: { copy: "" }, warnings: [] }, signTransaction, rpc, setPhase);
      if (end.kind !== "confirmed") return false;
      notifyTxConfirmed();
    }
    setProgress(null);
    return true;
  }

  /** Redeem (spec 7.4): one builder call for up to REDEEM_MAX markets; it packs them into as few transactions as fit. */
  async function redeem(ids: string[]) {
    for (let i = 0; i < ids.length; i += REDEEM_MAX) {
      setPhase({ kind: "building" });
      let r: TxResponse;
      try {
        r = await api.txRedeem({ owner, marketIds: ids.slice(i, i + REDEEM_MAX) });
      } catch (e) {
        setPhase({ kind: "failed", message: (e as Error).message });
        return;
      }
      const txs = (r.transactions ?? [r.transaction]).map((transaction) => ({ transaction, lastValidBlockHeight: r.lastValidBlockHeight }));
      if (!(await sendAll("Redeeming transaction", txs))) return;
    }
  }

  async function claimAll() {
    for (const row of ledgerRows) {
      setPhase({ kind: "building" });
      let r: TxResponse;
      try {
        r = await api.txWithdraw({ owner, marketId: row.marketId });
      } catch (e) {
        setPhase({ kind: "failed", message: (e as Error).message });
        return;
      }
      if (!(await sendAll("Claiming", [r]))) return;
    }
  }

  return (
    <div>
      <div className="page-head row">
        <div>
          <h1>Portfolio</h1>
          <p className="muted">Positions are marked at the book mid. Settled winners redeem for $1.00 a token.</p>
        </div>
        <div className="seg" role="tablist">
          <button className={tab === "positions" ? "on" : ""} onClick={() => setTab("positions")} role="tab" aria-selected={tab === "positions"}>Positions</button>
          <button className={tab === "maker" ? "on" : ""} onClick={() => setTab("maker")} role="tab" aria-selected={tab === "maker"} data-testid="maker-tab">Maker view</button>
        </div>
      </div>

      <div className="stats-row">
        <div className="stat-card"><div className="muted tiny">Wallet USDC</div><div className="stat-big mono">{micro === null ? "…" : usd(micro)}</div></div>
        <div className="stat-card"><div className="muted tiny">Unrealized P&L</div><div className={`stat-big mono ${pnlClass(unreal.toString())}`} data-testid="total-unrealized">{usd(unreal, { sign: true })}</div></div>
        <div className="stat-card"><div className="muted tiny">Realized P&L</div><div className={`stat-big mono ${pnlClass(real.toString())}`}>{usd(real, { sign: true })}</div></div>
        <div className="stat-card"><div className="muted tiny">To claim / redeem</div><div className="stat-big mono">{usd(BigInt(c?.totals.ledgerUsdc ?? "0") + BigInt(c?.totals.redeemable ?? "0"))}</div></div>
      </div>

      {ledgerRows.length > 0 || redeemIds.length > 0 ? (
        <div className="action-bar card">
          {ledgerRows.length > 0 ? (
            <div className="action">
              <div>
                <strong>Unclaimed proceeds {usd(c!.totals.ledgerUsdc)}</strong>
                <div className="muted small">Fills on your resting orders wait in your Meridian ledger until you claim them.</div>
              </div>
              <button className="btn btn-primary" onClick={() => void claimAll()} disabled={busy} data-testid="claim">Claim {usd(c!.totals.ledgerUsdc)}</button>
            </div>
          ) : null}
          {redeemIds.length > 0 ? (
            <div className="action">
              <div>
                <strong>Winnings to redeem {usd(sum(settled.map((p) => p.redeemable)))}</strong>
                <div className="muted small">{redeemIds.length} settled {redeemIds.length === 1 ? "contract" : "contracts"}. Your wallet asks once per transaction.</div>
              </div>
              <button className="btn btn-yes" onClick={() => void redeem(redeemIds)} disabled={busy} data-testid="redeem">Redeem</button>
            </div>
          ) : null}
          {progress ? <div className="small muted">{progress}</div> : null}
          <TxStatus phase={phase} explorer={(s) => explorerTx(s, config)} />
        </div>
      ) : null}

      {tab === "positions" ? (
        <>
          <section className="card">
            <div className="card-head"><h3>Open positions</h3><span className="muted tiny">{open.length}</span></div>
            {open.length === 0 ? <div className="empty small">No open positions. <Link href="/markets/">Find a market</Link>.</div> : (
              <div className="table-wrap">
                <table className="table" data-testid="open-positions">
                  <thead><tr><th>Contract</th><th>Side</th><th className="r">Qty</th><th className="r">Entry</th><th className="r">Mark</th><th className="r">Unrealized</th><th className="r">Realized</th><th className="r">Pays if right</th></tr></thead>
                  <tbody>
                    {open.map((p) => (
                      <tr key={p.marketId} data-testid={`pos-${p.marketId}`}>
                        <td><Link href={`/trade/?m=${p.marketId}`}>{p.symbol} ≥ ${p.strike}</Link></td>
                        <td><span className={`side side-${p.side.toLowerCase()}`} data-testid="side">{sideLabel(p)}</span></td>
                        <td className="r mono">{p.qty}</td>
                        <td className="r mono">{cents(p.avgEntryCents)}</td>
                        <td className="r mono">{cents(p.markCents)}</td>
                        <td className={`r mono ${pnlClass(p.unrealizedPnl)}`} data-testid="unrealized">{usd(p.unrealizedPnl, { sign: true })}</td>
                        <td className={`r mono ${pnlClass(p.realizedPnl)}`}>{usd(p.realizedPnl, { sign: true })}</td>
                        <td className="r mono">{usd(p.payoutIfWin)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-head"><h3>Settled</h3><span className="muted tiny">{settled.length}</span></div>
            {settled.length === 0 ? <div className="empty small">Nothing settled yet. Contracts settle after the 4:00 PM ET close.</div> : (
              <div className="table-wrap">
                <table className="table" data-testid="settled-positions">
                  <thead><tr><th>Contract</th><th>Side</th><th className="r">Qty</th><th className="r">Close</th><th>Outcome</th><th className="r">Per token</th><th className="r">Payout</th><th /></tr></thead>
                  <tbody>
                    {settled.map((p) => {
                      const isNo = p.side === "NO";
                      const win = p.status === "VOID" ? null : p.outcome === (isNo ? "NO" : "YES");
                      const per = p.status === "VOID" ? "$0.50" : win ? "$1.00" : "$0.00";
                      const cl = closes[p.marketId];
                      return (
                        <tr key={p.marketId} data-testid={`settled-${p.marketId}`}>
                          <td>{p.symbol} ≥ ${p.strike}</td>
                          <td><span className={`side side-${p.side.toLowerCase()}`}>{sideLabel(p)}</span></td>
                          <td className="r mono">{p.qty}</td>
                          <td className="r mono" data-testid="close-price">{cl?.closePrice ? price(cl.closePrice) : "—"}{cl?.provisional ? <span className="tag tag-dim">provisional</span> : null}</td>
                          <td><span className={`outcome ${p.outcome === "YES" ? "yes" : p.outcome === "NO" ? "no" : ""}`}>{p.status === "VOID" ? "Void" : p.outcome}</span></td>
                          <td className={`r mono ${win ? "pos" : win === false ? "neg" : ""}`} data-testid="per-token">{per}</td>
                          <td className="r mono">{usd(p.redeemed ? "0" : p.redeemable)}</td>
                          <td className="r">
                            {p.redeemed ? <span className="muted small">Redeemed</span>
                              : BigInt(p.redeemable) > 0n ? <span className="tag">Redeemable</span>
                              : p.qty > 0 ? <button className="link small" disabled={busy} onClick={() => void redeem([p.marketId])} title="Burn the losing tokens; pays $0.00" data-testid="clear">Clear</button>
                              : <span className="muted small">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : (
        <MakerView positions={all} open={openOrders.data?.data ?? []} all={allOrders.data?.data ?? []} />
      )}
    </div>
  );
}

/** Exposure of resting orders, order fills and P&L, for market makers (PRD "Market Maker"). */
export function MakerView({ positions, open, all }: { positions: Position[]; open: Order[]; all: Order[] }) {
  const label = (id: string) => {
    const p = positions.find((x) => x.marketId === id);
    return p ? `${p.symbol} ≥ $${p.strike}` : `${id.slice(0, 4)}…${id.slice(-4)}`;
  };
  // USDC a buy can spend (qty × price); contracts a sell can deliver.
  const byMarket = new Map<string, { buyUsdc: bigint; sellQty: number; orders: number }>();
  for (const o of open) {
    const e = byMarket.get(o.marketId) ?? { buyUsdc: 0n, sellQty: 0, orders: 0 };
    if (o.intent === "BUY_YES" || o.intent === "BUY_NO") e.buyUsdc += BigInt(o.remaining) * BigInt(o.priceCents) * 10_000n;
    else e.sellQty += o.remaining;
    e.orders++;
    byMarket.set(o.marketId, e);
  }
  const fills = all.filter((o) => o.filled > 0);
  const pnl = positions.reduce((a, p) => a + BigInt(p.realizedPnl) + BigInt(p.unrealizedPnl), 0n);
  return (
    <div data-testid="maker-view">
      <section className="card">
        <div className="card-head"><h3>Resting exposure</h3><span className={`mono ${pnlClass(pnl.toString())}`}>Total P&L {usd(pnl, { sign: true })}</span></div>
        {byMarket.size === 0 ? <div className="empty small">No resting orders.</div> : (
          <table className="table">
            <thead><tr><th>Contract</th><th className="r">Orders</th><th className="r">Bids (USDC at risk)</th><th className="r">Offers (contracts)</th></tr></thead>
            <tbody>
              {[...byMarket.entries()].map(([id, e]) => (
                <tr key={id}><td>{label(id)}</td><td className="r mono">{e.orders}</td><td className="r mono">{usd(e.buyUsdc)}</td><td className="r mono">{e.sellQty}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card">
        <div className="card-head"><h3>Order fills</h3></div>
        {fills.length === 0 ? <div className="empty small">No fills on your orders yet.</div> : (
          <table className="table">
            <thead><tr><th>Contract</th><th>Order</th><th className="r">Price</th><th className="r">Filled</th><th>Status</th></tr></thead>
            <tbody>
              {fills.map((o) => (
                <tr key={o.orderId}><td>{label(o.marketId)}</td><td>{INTENT_LABEL[o.intent]}</td><td className="r mono">{o.priceCents}¢</td><td className="r mono">{o.filled}/{o.qty}</td><td className="muted small">{o.status.toLowerCase()}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
