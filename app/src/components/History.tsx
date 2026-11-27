"use client";
/** MER-75: execution log by user intent (never the raw book side), with explorer links. */
import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { explorerTx } from "@/lib/config";
import { etDateTime, INTENT_DONE, usd } from "@/lib/format";
import { useServices } from "@/lib/services";
import type { HistoryItem } from "@/lib/types";
import { useUserResource } from "@/lib/user";
import { SignInPrompt } from "./Portfolio";

function useMarketLabels(ids: string[]) {
  const { api } = useServices();
  const [labels, setLabels] = useState<Record<string, string>>({});
  const key = [...new Set(ids)].sort().join(",");
  useEffect(() => {
    if (!key) return;
    let live = true;
    Promise.all(key.split(",").map((id) => api.market(id).then((m) => [id, `${m.symbol} ≥ $${m.strike}`] as const, () => [id, `${id.slice(0, 4)}…${id.slice(-4)}`] as const))).then(
      (rows) => live && setLabels(Object.fromEntries(rows)),
    );
    return () => {
      live = false;
    };
  }, [api, key]);
  return labels;
}

export function amountFor(h: HistoryItem): string {
  if (h.usdc) return usd(h.usdc);
  if (h.priceCents == null) return "—";
  const gross = BigInt(h.qty) * BigInt(h.priceCents) * 10_000n;
  const buy = h.intent.startsWith("BUY");
  return usd(buy ? gross + BigInt(h.fee) : gross - BigInt(h.fee));
}

export function HistoryTable({ rows, labels, explorer }: { rows: HistoryItem[]; labels: Record<string, string>; explorer: (s: string) => string }) {
  if (rows.length === 0) return <div className="empty small">No executions yet. Your fills, mints and redemptions appear here.</div>;
  return (
    <div className="table-wrap">
      <table className="table" data-testid="history-table">
        <thead><tr><th>Time (ET)</th><th>Action</th><th>Contract</th><th className="r">Qty</th><th className="r">Price</th><th className="r">Fee</th><th className="r">Amount</th><th>Tx</th></tr></thead>
        <tbody>
          {rows.map((h, i) => {
            const no = h.intent.endsWith("_NO");
            return (
              <tr key={`${h.signature}-${i}`} data-testid="history-row">
                <td className="muted">{etDateTime(h.time)}</td>
                <td><span className={`intent-chip ${h.intent.endsWith("YES") ? "yes" : no ? "no" : ""}`} data-testid="intent">{INTENT_DONE[h.intent] ?? h.intent}</span></td>
                <td>{labels[h.marketId] ?? "…"}</td>
                <td className="r mono">{h.qty}</td>
                <td className="r mono">{h.priceCents == null ? "—" : `${h.priceCents}¢ ${no ? "No" : "Yes"}`}</td>
                <td className="r mono">{BigInt(h.fee) > 0n ? usd(h.fee) : "—"}</td>
                <td className="r mono">{amountFor(h)}</td>
                <td><a className="mono small" href={explorer(h.signature)} target="_blank" rel="noreferrer" data-testid="sig-link">{h.signature.slice(0, 8)}…</a></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function HistoryView() {
  const { api, config } = useServices();
  const { connected } = useWallet();
  const auth = useAuth();
  const [more, setMore] = useState<HistoryItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const hist = useUserResource((t) => api.history(t, 50), { prompt: true });
  useEffect(() => {
    setMore([]);
    setNext(hist.data?.nextBefore ?? null);
  }, [hist.data]);
  const labels = useMarketLabels([...(hist.data?.data ?? []), ...more].map((h) => h.marketId));

  if (!connected) return <div className="empty big-empty"><h2>Connect a wallet to see your history</h2></div>;
  if (auth.status !== "signed_in") return <SignInPrompt />;
  const rows = [...(hist.data?.data ?? []), ...more];
  return (
    <div>
      <div className="page-head">
        <h1>History</h1>
        <p className="muted">Every execution, in the terms you traded. Each row links to its transaction on the Solana explorer.</p>
      </div>
      <section className="card">
        {!hist.data ? <div className="empty small">Loading…</div> : <HistoryTable rows={rows} labels={labels} explorer={(s) => explorerTx(s, config)} />}
        {next ? (
          <button className="btn btn-sm" onClick={async () => {
            const r = await api.history(auth.token, 50, next);
            setMore((m) => [...m, ...r.data]);
            setNext(r.nextBefore);
          }}>Load more</button>
        ) : null}
      </section>
    </div>
  );
}
