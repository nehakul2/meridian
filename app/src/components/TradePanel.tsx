"use client";
/**
 * MER-73: the four intents (Buy Yes, Buy No, Sell Yes, Sell No) with market and limit orders.
 *
 * - Market orders always send a worst acceptable price (A18): the best price for the intent
 *   plus (buys) or minus (sells) the user's slippage from prefs.
 * - Position guard (PRD "Position Constraints"): holding No disables Buy Yes with a "Sell No
 *   first" action, and the reverse. The Tx Builder enforces the same rule with a 409
 *   `POSITION_CONFLICT` whose `requiredAction` is shown if the local state was stale.
 * - The payoff line is the Tx Builder's `summary.copy`, shown verbatim.
 * - Disabled after `close_time`, when paused and on the wrong network, with the reason.
 */
import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { explorerTx } from "@/lib/config";
import { etTime, INTENT_LABEL, usd } from "@/lib/format";
import { useChannel, useServices } from "@/lib/services";
import { useServerNow, useStatus } from "@/lib/status";
import { signSendConfirm, type TxPhase } from "@/lib/tx";
import type { Intent, Market, Position, TradeRequest, TxResponse } from "@/lib/types";
import { notifyTxConfirmed } from "@/lib/user";

const INTENTS: Intent[] = ["BUY_YES", "BUY_NO", "SELL_YES", "SELL_NO"];

export function bestFor(intent: Intent, m: Market): number | null {
  switch (intent) {
    case "BUY_YES": return m.yes.ask;
    case "SELL_YES": return m.yes.bid;
    case "BUY_NO": return m.no.ask;
    case "SELL_NO": return m.no.bid;
  }
}

/** Worst acceptable price for a market order (A18): best ± slippage, clamped to 1..99. */
export function worstPrice(intent: Intent, best: number | null, slippage: number): number | null {
  if (best == null) return null;
  const buy = intent === "BUY_YES" || intent === "BUY_NO";
  return buy ? Math.min(99, best + slippage) : Math.max(1, best - slippage);
}

export interface Guard {
  blocked: boolean;
  reason?: string;
  action?: { label: string; intent?: Intent; qty?: number; cancel?: boolean };
}

/**
 * Local position guard per intent, mirroring the Tx Builder's checks. `undefined` means the
 * position is unknown (not signed in): nothing is blocked locally and the builder's 409 decides.
 */
export function guardFor(intent: Intent, p: Position | null | undefined): Guard {
  if (p === undefined) return { blocked: false };
  const yes = p?.yesQty ?? 0;
  const no = p?.noQty ?? 0;
  const pending = p?.side === "BOTH_PENDING";
  switch (intent) {
    case "BUY_YES":
      if (pending) return { blocked: true, reason: "You have a Buy No order resting on this contract.", action: { label: "Cancel Buy No first", cancel: true } };
      if (no > 0) return { blocked: true, reason: `You hold ${no} No. Exit it before buying Yes.`, action: { label: "Sell No first", intent: "SELL_NO", qty: no } };
      return { blocked: false };
    case "BUY_NO":
      if (yes > 0 && !pending) return { blocked: true, reason: `You hold ${yes} Yes. Exit it before buying No.`, action: { label: "Sell Yes first", intent: "SELL_YES", qty: yes } };
      return { blocked: false };
    case "SELL_YES":
      if (yes === 0 || pending) return { blocked: true, reason: "You have no Yes to sell on this contract." };
      return { blocked: false };
    case "SELL_NO":
      if (no === 0 || pending) return { blocked: true, reason: "You have no No to sell on this contract." };
      return { blocked: false };
  }
}

function conflictGuard(e: ApiError): Guard {
  const d = e.details as { requiredAction?: string; yes?: number; no?: number; available?: number };
  switch (d.requiredAction) {
    case "SELL_NO": return { blocked: true, reason: e.message, action: { label: "Sell No first", intent: "SELL_NO", qty: d.no } };
    case "SELL_YES": return { blocked: true, reason: e.message, action: { label: "Sell Yes first", intent: "SELL_YES", qty: d.yes } };
    case "CANCEL_BUY_NO": return { blocked: true, reason: e.message, action: { label: "Cancel Buy No first", cancel: true } };
    case "REDUCE_QTY": return { blocked: true, reason: e.message, action: d.available ? { label: `Use ${d.available}`, qty: d.available } : undefined };
    default: return { blocked: true, reason: e.message };
  }
}

export function TradePanel({ market, position, slippageCents = 2, initialIntent = "BUY_YES", pickedPrice }: {
  market: Market;
  /** null: signed in and flat here; undefined: unknown. */
  position: Position | null | undefined;
  slippageCents?: number;
  initialIntent?: Intent;
  /** A price clicked in the book, in the current intent's terms. */
  pickedPrice?: { price: number; at: number; intent?: Intent } | null;
}) {
  const { api, rpc, config } = useServices();
  const { publicKey, connected, signTransaction } = useWallet();
  const auth = useAuth();
  const { status, network, synced } = useStatus();
  const now = useServerNow(1000);
  const owner = connected && publicKey ? publicKey.toBase58() : null;

  const [intent, setIntent] = useState<Intent>(initialIntent);
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT">("MARKET");
  const [qty, setQty] = useState("10");
  const [limit, setLimit] = useState("");
  const [preview, setPreview] = useState<TxResponse | null>(null);
  const [previewErr, setPreviewErr] = useState<ApiError | null>(null);
  const [phase, setPhase] = useState<TxPhase>({ kind: "idle" });
  const [submitted, setSubmitted] = useState<{ qty: number; type: "MARKET" | "LIMIT"; warnings: string[] } | null>(null);
  const [fills, setFills] = useState<Record<string, number>>({});
  const reqId = useRef(0);

  useEffect(() => setIntent(initialIntent), [initialIntent]);
  useEffect(() => {
    if (!pickedPrice) return;
    if (pickedPrice.intent) setIntent(pickedPrice.intent);
    setOrderType("LIMIT");
    setLimit(String(pickedPrice.price));
  }, [pickedPrice]);

  // Fills for our signatures, for the partial fill notice.
  useChannel(auth.status === "signed_in" ? "user" : null, (m) => {
    if (m.type === "fill" && m.market === market.marketId && typeof m.sig === "string") {
      const q = Number(m.qty);
      setFills((f) => ({ ...f, [m.sig as string]: (f[m.sig as string] ?? 0) + q }));
    }
  });

  const best = bestFor(intent, market);
  const worst = worstPrice(intent, best, slippageCents);
  const q = Number(qty);
  const qtyOk = Number.isInteger(q) && q >= 1;
  const limitN = Number(limit);
  const limitOk = Number.isInteger(limitN) && limitN >= 1 && limitN <= 99;
  const priceCents = orderType === "MARKET" ? worst : limitOk ? limitN : null;

  const closeAt = market.closeTimeUnix ? market.closeTimeUnix * 1000 : null;
  const closed = market.status !== "TRADING" || (synced && closeAt !== null && now >= closeAt);
  const disabledReason = useMemo(() => {
    if (status?.paused) return "Trading is paused by the protocol. Cancels, claims and redemptions still work.";
    if (closed) {
      if (market.status === "SETTLED") return `This contract settled ${market.outcome}.`;
      if (market.status === "PRE_OPEN" || market.status === "MINT_ONLY") return `The book opens at ${market.closeTimeUnix && status?.openTime ? etTime(status.openTime) : "the open"}.`;
      return `Trading closed at ${market.closeTimeUnix ? etTime(market.closeTimeUnix) : "the close"}. The contract settles on the official closing price.`;
    }
    if (!network.ok) return network.reason;
    return null;
  }, [status?.paused, status?.openTime, closed, market.status, market.outcome, market.closeTimeUnix, network]);

  const localGuard = guardFor(intent, position);
  const serverGuard = previewErr?.code === "POSITION_CONFLICT" ? conflictGuard(previewErr) : null;
  const guard = localGuard.blocked ? localGuard : serverGuard ?? localGuard;
  const busy = phase.kind === "building" || phase.kind === "signing" || phase.kind === "pending";

  const request = (): TradeRequest | null => {
    if (!owner || !qtyOk || priceCents == null) return null;
    return { owner, marketId: market.marketId, intent, orderType, qty: q, priceCents };
  };

  // Live quote from the Tx Builder (debounced), so the payoff copy is the builder's own.
  useEffect(() => {
    setPreview(null);
    setPreviewErr(null);
    const r = request();
    if (!r || disabledReason || localGuard.blocked || busy) return;
    const id = ++reqId.current;
    const t = setTimeout(() => {
      api.txTrade(r).then(
        (res) => id === reqId.current && setPreview(res),
        (e) => id === reqId.current && setPreviewErr(e instanceof ApiError ? e : new ApiError("INTERNAL", String(e), 0)),
      );
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, market.marketId, intent, orderType, q, priceCents, disabledReason, localGuard.blocked, market.seq]);

  async function submit() {
    const r = request();
    if (!r) return;
    setPhase({ kind: "building" });
    let built: TxResponse;
    try {
      built = await api.txTrade({ ...r, clientOrderId: Math.random().toString(36).slice(2, 12) });
    } catch (e) {
      // A refusal from the builder (409 guard, 422 size, halted…) is shown where the quote goes.
      if (e instanceof ApiError && e.status !== 0) {
        setPreviewErr(e);
        setPhase({ kind: "idle" });
      } else setPhase({ kind: "failed", message: (e as Error).message });
      return;
    }
    setSubmitted({ qty: r.qty, type: r.orderType, warnings: built.warnings });
    const end = await signSendConfirm(built, signTransaction, rpc, setPhase);
    if (end.kind === "confirmed") notifyTxConfirmed();
  }

  async function cancelBuyNo() {
    if (!owner) return;
    setPhase({ kind: "building" });
    try {
      const built = await api.txCancel({ owner, marketId: market.marketId, all: true });
      const end = await signSendConfirm(built, signTransaction, rpc, setPhase);
      if (end.kind === "confirmed") {
        notifyTxConfirmed();
        setPreviewErr(null);
      }
    } catch (e) {
      setPhase({ kind: "failed", message: (e as Error).message });
    }
  }

  function takeAction(a: NonNullable<Guard["action"]>) {
    if (a.cancel) return void cancelBuyNo();
    if (a.intent) setIntent(a.intent);
    if (a.qty) setQty(String(a.qty));
    setPhase({ kind: "idle" });
  }

  const isNo = intent === "BUY_NO" || intent === "SELL_NO";
  const buy = intent === "BUY_YES" || intent === "BUY_NO";
  const sig = phase.kind === "pending" || phase.kind === "confirmed" ? phase.signature : phase.kind === "failed" ? phase.signature : undefined;
  const filled = sig ? fills[sig] : undefined;
  const canSubmit = !!owner && !disabledReason && !guard.blocked && qtyOk && priceCents != null && !busy && !!preview;

  return (
    <div className="card trade" data-testid="trade-panel">
      <div className="intent-tabs" role="tablist">
        {INTENTS.map((i) => {
          const g = guardFor(i, position);
          const yes = i.endsWith("YES");
          return (
            <button key={i} role="tab" aria-selected={intent === i} className={`intent ${yes ? "yes" : "no"}${intent === i ? " on" : ""}${g.blocked ? " guarded" : ""}`}
              onClick={() => { setIntent(i); setPhase({ kind: "idle" }); }} data-testid={`intent-${i}`}>
              {INTENT_LABEL[i]}
            </button>
          );
        })}
      </div>

      <div className="seg seg-sm" role="group" aria-label="Order type">
        <button className={orderType === "MARKET" ? "on" : ""} aria-pressed={orderType === "MARKET"} onClick={() => setOrderType("MARKET")}>Market</button>
        <button className={orderType === "LIMIT" ? "on" : ""} aria-pressed={orderType === "LIMIT"} onClick={() => { setOrderType("LIMIT"); if (!limit && best != null) setLimit(String(best)); }}>Limit</button>
      </div>

      <label className="field">
        <span>Contracts</span>
        <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ""))} aria-label="Contracts" data-testid="qty" />
      </label>

      {orderType === "LIMIT" ? (
        <label className="field">
          <span>Limit price ({isNo ? "No" : "Yes"}, ¢)</span>
          <input inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^0-9]/g, ""))} aria-label="Limit price" data-testid="limit-price" />
        </label>
      ) : (
        <div className="field-static" data-testid="worst-price">
          <span>Worst price</span>
          <span className="mono">
            {worst == null ? "No liquidity" : `${worst}¢`}
            {best != null ? <span className="muted small"> (best {best}¢ {buy ? "+" : "−"} {slippageCents}¢ slippage)</span> : null}
          </span>
        </div>
      )}

      {position && position.side !== "FLAT" ? (
        <div className="holding small" data-testid="holding">
          You hold {position.side === "BOTH_PENDING" ? `${position.noQty} No (Buy No pending)` : [position.yesQty ? `${position.yesQty} Yes` : null, position.noQty ? `${position.noQty} No` : null].filter(Boolean).join(" and ")}
        </div>
      ) : owner && auth.status !== "signed_in" ? (
        <button className="link small" onClick={() => void auth.ensureToken().catch(() => undefined)} data-testid="signin-for-position">Sign in to see your position here</button>
      ) : null}

      {disabledReason ? (
        <div className="notice notice-warn" data-testid="trade-disabled">{disabledReason}</div>
      ) : guard.blocked ? (
        <div className="notice notice-warn" data-testid="guard">
          <span>{guard.reason}</span>
          {guard.action ? <button className="btn btn-sm" onClick={() => takeAction(guard.action!)} data-testid="guard-action">{guard.action.label}</button> : null}
        </div>
      ) : previewErr ? (
        <div className="notice notice-danger" data-testid="preview-error">{previewErr.message}</div>
      ) : null}

      {!preview && owner && (disabledReason || guard.blocked) ? null : <div className="payoff" data-testid="payoff">
        {preview ? (
          <>
            <p className="payoff-copy" data-testid="summary-copy">{preview.summary.copy}</p>
            <div className="payoff-row small">
              {buy ? <span>Max cost <strong className="mono">{usd(preview.summary.maxCost)}</strong></span> : <span>Min proceeds <strong className="mono">{usd(preview.summary.minProceeds as string)}</strong></span>}
              {buy ? <span>Payout if right <strong className="mono">{usd(preview.summary.payoutIfWin)}</strong></span> : null}
            </div>
            {preview.warnings.includes("PARTIAL_FILL_LIKELY") ? <p className="small warn-text" data-testid="partial-warning">Not enough resting orders at your worst price: part of this order may not fill{orderType === "MARKET" ? ", and the rest is cancelled" : " now"}.</p> : null}
            {preview.warnings.includes("LEDGER_WITHDRAW_BUNDLED") ? <p className="small muted">Your unclaimed proceeds are withdrawn in the same transaction.</p> : null}
          </>
        ) : owner ? (
          <p className="muted small">Getting a quote…</p>
        ) : (
          <p className="muted small">Each contract pays $1.00 if {market.symbol} closes {intent.endsWith("NO") ? "below" : "at or above"} ${market.strike}. Connect a wallet for an exact quote.</p>
        )}
      </div>}

      <button className={`btn btn-block ${intent.endsWith("YES") ? "btn-yes" : "btn-no"}`} disabled={!canSubmit} onClick={() => void submit()} data-testid="submit">
        {!owner ? "Connect a wallet to trade" : busy ? (phase.kind === "signing" ? "Approve in wallet…" : phase.kind === "pending" ? "Confirming…" : "Building…") : `${INTENT_LABEL[intent]}${qtyOk ? ` ${q}` : ""}`}
      </button>

      <TxStatus phase={phase} explorer={(s) => explorerTx(s, config)} filled={filled} submitted={submitted} onRetry={() => void submit()} />
    </div>
  );
}

export function TxStatus({ phase, explorer, filled, submitted, onRetry }: {
  phase: TxPhase;
  explorer: (sig: string) => string;
  filled?: number;
  submitted?: { qty: number; type: "MARKET" | "LIMIT"; warnings: string[] } | null;
  onRetry?: () => void;
}) {
  if (phase.kind === "idle" || phase.kind === "building" || phase.kind === "signing") return null;
  if (phase.kind === "rejected") {
    return (
      <div className="notice notice-warn" data-testid="tx-status" data-state="rejected">
        <span>Transaction cancelled. You rejected it in your wallet, so nothing was sent.</span>
        {onRetry ? <button className="btn btn-sm" onClick={onRetry}>Try again</button> : null}
      </div>
    );
  }
  if (phase.kind === "pending") {
    return <div className="notice notice-info" data-testid="tx-status" data-state="pending"><span className="spinner" /> Sent. Waiting for confirmation… <a href={explorer(phase.signature)} target="_blank" rel="noreferrer">View</a></div>;
  }
  if (phase.kind === "failed") {
    return (
      <div className="notice notice-danger" data-testid="tx-status" data-state="failed">
        <span>{phase.message}</span>
        {phase.signature ? <a href={explorer(phase.signature)} target="_blank" rel="noreferrer">View</a> : null}
      </div>
    );
  }
  const partial = submitted && filled !== undefined && filled < submitted.qty;
  return (
    <div className="notice notice-ok" data-testid="tx-status" data-state="confirmed">
      <span>
        Confirmed.{" "}
        {partial ? (
          <strong data-testid="partial-fill">Filled {filled} of {submitted!.qty}{submitted!.type === "MARKET" ? "; the rest was cancelled." : "; the rest is resting on the book."}</strong>
        ) : filled !== undefined && submitted ? `Filled ${filled}.` : null}
      </span>
      <a href={explorer(phase.signature)} target="_blank" rel="noreferrer">View on explorer</a>
    </div>
  );
}
