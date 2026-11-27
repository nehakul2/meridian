/** Display helpers. Money from the API is integer micro-USDC strings; prices are integer cents. */
import type { Intent } from "./types";

export function usd(micro: string | bigint | number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (micro === null || micro === undefined || micro === "") return "—";
  const m = BigInt(micro);
  const neg = m < 0n;
  const a = neg ? -m : m;
  const c = a / 10_000n;
  const whole = (c / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const s = `$${whole}.${(c % 100n).toString().padStart(2, "0")}`;
  if (neg) return `-${s}`;
  return opts.sign && m > 0n ? `+${s}` : s;
}

export const cents = (c: number | null | undefined) => (c === null || c === undefined ? "—" : `${Number.isInteger(c) ? c : c.toFixed(1)}¢`);

/** Implied probability (D14, from the book mid) as a whole percent. */
export function pct(p: number | null | undefined): string {
  if (p === null || p === undefined || Number.isNaN(p)) return "—";
  return `${Math.round(p * 100)}%`;
}

export function price(s: string | null | undefined): string {
  if (!s) return "—";
  const n = Number(s);
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function change(px: string | null | undefined, prev: string | null | undefined): { text: string; dir: "up" | "down" | "flat" } | null {
  if (!px || !prev) return null;
  const d = Number(px) - Number(prev);
  const p = (d / Number(prev)) * 100;
  const dir = Math.abs(d) < 0.005 ? "flat" : d > 0 ? "up" : "down";
  return { text: `${d >= 0 ? "+" : ""}${d.toFixed(2)} (${p >= 0 ? "+" : ""}${p.toFixed(2)}%)`, dir };
}

export const INTENT_LABEL: Record<string, string> = {
  BUY_YES: "Buy Yes",
  SELL_YES: "Sell Yes",
  BUY_NO: "Buy No",
  SELL_NO: "Sell No",
  MINT: "Mint pair",
  MERGE: "Merge pair",
  REDEEM: "Redeem",
};

/** Past tense for the execution log (history shows the user's intent, never the raw book side). */
export const INTENT_DONE: Record<string, string> = {
  BUY_YES: "Bought Yes",
  SELL_YES: "Sold Yes",
  BUY_NO: "Bought No",
  SELL_NO: "Sold No",
  MINT: "Minted pairs",
  MERGE: "Merged pairs",
  REDEEM: "Redeemed",
};

export const isNoIntent = (i: Intent) => i === "BUY_NO" || i === "SELL_NO";

export function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

/** "4:00 PM ET" (or "2:12:03 PM ET" with seconds) */
export function etTime(isoOrUnix: string | number, seconds = false): string {
  const d = typeof isoOrUnix === "number" ? new Date(isoOrUnix * 1000) : new Date(isoOrUnix);
  return `${d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) })} ET`;
}

export function etDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export function strikeLabel(symbol: string, strike: string): string {
  return `${symbol} ≥ $${strike}`;
}
