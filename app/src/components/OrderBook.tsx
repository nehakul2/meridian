"use client";
/**
 * MER-72: one book, two perspectives. The Yes view shows the book as stored; the No view
 * shows the same levels at 100 − p with sides swapped (No bids from Yes asks, No asks from
 * Yes bids). The chosen view is saved to `user_prefs.default_view` when signed in.
 */
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { levels, type BookState } from "@/lib/book";
import { useServices } from "@/lib/services";
import type { Level, View } from "@/lib/types";

const LOCAL_KEY = "meridian.defaultView";

/** The user's default view: prefs when signed in, else the last choice in this browser. */
export function useDefaultView(): [View, (v: View) => void] {
  const { api } = useServices();
  const auth = useAuth();
  const [view, setView] = useState<View>(() => {
    try {
      return (localStorage.getItem(LOCAL_KEY) as View) === "NO" ? "NO" : "YES";
    } catch {
      return "YES";
    }
  });
  useEffect(() => {
    if (auth.status !== "signed_in") return;
    let live = true;
    api.prefs(auth.token).then((p) => live && setView(p.defaultView), () => undefined);
    return () => {
      live = false;
    };
  }, [api, auth.status, auth.token, auth.epoch]);
  const choose = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(LOCAL_KEY, v);
    } catch {
      /* ignore */
    }
    if (auth.status === "signed_in") void api.putPrefs(auth.token, { defaultView: v }).catch(() => undefined);
  };
  return [view, choose];
}

export function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <div className="seg" role="group" aria-label="Book view">
      <button className={view === "YES" ? "on yes" : ""} aria-pressed={view === "YES"} onClick={() => onChange("YES")}>Yes view</button>
      <button className={view === "NO" ? "on no" : ""} aria-pressed={view === "NO"} onClick={() => onChange("NO")}>No view</button>
    </div>
  );
}

function Rows({ rows, side, max, onPick }: { rows: Level[]; side: "bid" | "ask"; max: number; onPick?: (p: number, side: "bid" | "ask") => void }) {
  return (
    <>
      {rows.map(([p, q]) => (
        <tr key={`${side}-${p}`} className={`lvl lvl-${side}`} data-testid={`${side}-${p}`} onClick={() => onPick?.(p, side)}>
          <td className="mono price">{p}¢</td>
          <td className="mono qty">{q.toLocaleString("en-US")}</td>
          <td className="depth"><span style={{ width: `${Math.max(4, (q / max) * 100)}%` }} /></td>
        </tr>
      ))}
    </>
  );
}

export function OrderBook({ book, view, onViewChange, onPick, depth = 8 }: {
  book: BookState | null;
  view: View;
  onViewChange: (v: View) => void;
  onPick?: (priceCents: number, side: "bid" | "ask") => void;
  depth?: number;
}) {
  const lv = book ? levels(book, view, depth) : { bids: [], asks: [] };
  const max = Math.max(1, ...lv.bids.map((l) => l[1]), ...lv.asks.map((l) => l[1]));
  const bestBid = lv.bids[0]?.[0] ?? null;
  const bestAsk = lv.asks[0]?.[0] ?? null;
  const term = view === "YES" ? "Yes" : "No";
  return (
    <div className="card book" data-testid="order-book" data-view={view}>
      <div className="card-head">
        <h3>Order book</h3>
        <ViewToggle view={view} onChange={onViewChange} />
      </div>
      <p className="muted tiny book-note">
        {view === "YES" ? "Prices are for Yes." : "Same book in No terms: No bids are Yes asks at 100 − p, No asks are Yes bids at 100 − p."}
      </p>
      {!book ? <div className="empty small">Loading book…</div> : (
        <table className="book-table">
          <thead>
            <tr><th>{term} price</th><th>Contracts</th><th /></tr>
          </thead>
          <tbody>
            <Rows rows={[...lv.asks].reverse()} side="ask" max={max} onPick={onPick} />
            <tr className="spread"><td colSpan={3}>
              {bestBid != null && bestAsk != null ? <>Spread {bestAsk - bestBid}¢ · mid {((bestAsk + bestBid) / 2).toFixed(1)}¢</> : lv.bids.length + lv.asks.length === 0 ? "No resting orders" : "One-sided book"}
            </td></tr>
            <Rows rows={lv.bids} side="bid" max={max} onPick={onPick} />
          </tbody>
        </table>
      )}
      <div className="book-seq muted tiny mono" data-testid="book-seq">seq {book?.seq.toString() ?? "—"}</div>
    </div>
  );
}
