/**
 * MER-81 alert rules (spec 3.1 C9, spec 8, PRD "Liveness"). Pure: a snapshot of what Postgres,
 * Redis, RPC and the WS gateways say right now goes in, alert candidates come out. The Monitor
 * watches the system from outside Automation, so a dead scheduler still pages.
 *
 *   MORNING_INCOMPLETE   PAGE  08:45 ET, an enabled ticker (not skipped) has no ticker-day or no markets
 *   SETTLE_SLA_AT_RISK   WARN  close + 5 min, close not recorded (same code Automation uses)
 *   SETTLE_SLA_BREACHED  PAGE  close + 15 min, close not recorded, with the settler's last reason
 *   STRIKES_UNSETTLED    PAGE  final + 10 min, strikes still unsettled (see note below)
 *   STRIKE_REFUSED       PAGE  a strike inside the confidence band, waiting for the multisig (D27)
 *   INDEXER_LAG          WARN  newest program transaction not indexed after 5 s
 *   WS_GATEWAY_DOWN      WARN  a gateway's /healthz unreachable or not ready
 *   WS_GATEWAY_ERRORS    WARN  a gateway's error counter rose by more than the threshold since the last check
 *   INVARIANT_BREAK      PAGE  nightly reconcile found a vault or supply invariant break (same code as Automation)
 *
 * STRIKES_UNSETTLED: the task says "close + 10 min", which predates the 20-minute dispute window
 * (D8). Strikes may only settle from a FINAL price, so the 10 minutes are counted from
 * `finalized_at` (spec 8: STRIKE_CRANK runs on CloseFinalized). Refused strikes are reported by
 * STRIKE_REFUSED instead.
 */
import { etToUnix, IsoDate } from "../../automation/src/time.js";

export type Severity = "INFO" | "WARN" | "PAGE";

export interface AlertCandidate {
  severity: Severity;
  code: string;
  /** Ticker, or the gateway id for WS rules; null for system-wide alerts. */
  symbol: string | null;
  date: IsoDate | null;
  message: string;
}

export interface TickerDayRow {
  symbol: string;
  status: "OPEN" | "PROVISIONAL" | "DISPUTED" | "FINAL";
  closeTime: number;
  recordedAt: number | null;
  finalizedAt: number | null;
  priceRaw: bigint | null;
  expo: number | null;
  conf: bigint | null;
}

export interface MarketRow {
  symbol: string;
  strikeCents: bigint;
  status: "TRADING" | "HALTED" | "SETTLED" | "VOID";
}

export interface GatewayHealth {
  id: string;
  ok: boolean;
  errors?: number;
  /** The error counter at the previous check, when the gateway was reachable then. */
  prevErrors?: number;
  detail?: string;
}

export interface Snapshot {
  now: number;
  date: IsoDate;
  /** Today's calendar row; null on a holiday or weekend. */
  calendar: { closeTime: number } | null;
  tickers: string[];
  /** Tickers the morning job skipped today (corporate action, market status). */
  skipped: string[];
  tickerDays: TickerDayRow[];
  markets: MarketRow[];
  /** The settler's latest reason per ticker (job_runs SETTLE detail). */
  settleReason: Record<string, string>;
  indexer: { processedSlot: number | null; newestProgramTx: { slot: number; blockTime: number } | null };
  gateways: GatewayHealth[];
  /** Latest reconcile report for the date. */
  reconcile: { invariantBreaks: number; detail: string } | null;
}

export interface Thresholds {
  morningDeadline: { hh: number; mm: number };
  settleWarnS: number;
  settlePageS: number;
  strikesAfterFinalS: number;
  indexerLagS: number;
  wsErrorDelta: number;
}

export const DEFAULTS: Thresholds = {
  morningDeadline: { hh: 8, mm: 45 },
  settleWarnS: 5 * 60,
  settlePageS: 15 * 60,
  strikesAfterFinalS: 10 * 60,
  indexerLagS: 5,
  wsErrorDelta: 10,
};

/** |price - strike| < conf at full precision (spec 4.4, D27): the program refuses that strike. */
export function straddles(strikeCents: bigint, priceRaw: bigint, expo: number, conf: bigint): boolean {
  // Compare in units of 10^min(expo, -2) so neither side is rounded.
  const e = Math.min(expo, -2);
  const scaleP = 10n ** BigInt(expo - e);
  const scaleS = 10n ** BigInt(-2 - e);
  const diff = priceRaw * scaleP - strikeCents * scaleS;
  return (diff < 0n ? -diff : diff) < conf * scaleP;
}

const fmtStrikes = (xs: bigint[]) => xs.map((s) => `$${(Number(s) / 100).toFixed(2)}`).join(", ");
const mins = (s: number) => `${Math.floor(s / 60)} min`;

export function evaluate(s: Snapshot, t: Thresholds = DEFAULTS): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  const add = (severity: Severity, code: string, symbol: string | null, message: string, date: IsoDate | null = s.date) =>
    out.push({ severity, code, symbol, date, message });
  const days = new Map(s.tickerDays.map((d) => [d.symbol, d]));

  // Morning: every enabled, non-skipped ticker has a ticker-day and at least one market by 08:45 ET.
  if (s.calendar && s.now >= etToUnix(s.date, t.morningDeadline.hh, t.morningDeadline.mm)) {
    for (const sym of s.tickers) {
      if (s.skipped.includes(sym)) continue;
      const n = s.markets.filter((m) => m.symbol === sym).length;
      if (!days.has(sym) || n === 0) {
        add("PAGE", "MORNING_INCOMPLETE", sym, `${sym} ${s.date}: ${days.has(sym) ? "ticker-day created but no strike markets" : "no ticker-day on chain"} at 08:45 ET`);
      }
    }
  }

  for (const d of s.tickerDays) {
    // Close not recorded.
    if (d.status === "OPEN") {
      const late = s.now - d.closeTime;
      const reason = s.settleReason[d.symbol] ?? "no SETTLE run recorded";
      if (late >= t.settlePageS) add("PAGE", "SETTLE_SLA_BREACHED", d.symbol, `${d.symbol} close not recorded ${mins(late)} after close: ${reason}`);
      else if (late >= t.settleWarnS) add("WARN", "SETTLE_SLA_AT_RISK", d.symbol, `${d.symbol} close not recorded at close + 5 min: ${reason}`);
      continue;
    }
    if (d.status !== "FINAL") continue;
    const open = s.markets.filter((m) => m.symbol === d.symbol && (m.status === "TRADING" || m.status === "HALTED"));
    if (!open.length) continue;
    const refused = d.priceRaw !== null && d.expo !== null && d.conf !== null
      ? open.filter((m) => straddles(m.strikeCents, d.priceRaw!, d.expo!, d.conf!))
      : [];
    if (refused.length) {
      add("PAGE", "STRIKE_REFUSED", d.symbol, `${d.symbol} strikes ${fmtStrikes(refused.map((m) => m.strikeCents))} sit inside the confidence band: multisig admin_settle_market needed (D27)`);
    }
    const stuck = open.filter((m) => !refused.includes(m));
    if (stuck.length && d.finalizedAt !== null && s.now - d.finalizedAt >= t.strikesAfterFinalS) {
      add("PAGE", "STRIKES_UNSETTLED", d.symbol, `${d.symbol} ${stuck.length} strike(s) unsettled ${mins(s.now - d.finalizedAt)} after the close became final: ${fmtStrikes(stuck.map((m) => m.strikeCents))}`);
    }
  }

  // Indexer: the newest program transaction the chain has is indexed within 5 s.
  const tx = s.indexer.newestProgramTx;
  if (tx && (s.indexer.processedSlot === null || tx.slot > s.indexer.processedSlot)) {
    const lag = s.now - tx.blockTime;
    if (lag > t.indexerLagS) {
      add("WARN", "INDEXER_LAG", null, `indexer is ${lag}s behind: slot ${tx.slot} on chain, md:slot ${s.indexer.processedSlot ?? "unset"}`);
    }
  }

  for (const g of s.gateways) {
    if (!g.ok) add("WARN", "WS_GATEWAY_DOWN", g.id, `WS gateway ${g.id} unhealthy: ${g.detail ?? "not ready"}`);
    else if (g.errors !== undefined && g.prevErrors !== undefined && g.errors - g.prevErrors > t.wsErrorDelta) {
      add("WARN", "WS_GATEWAY_ERRORS", g.id, `WS gateway ${g.id}: ${g.errors - g.prevErrors} errors since the last check`);
    }
  }

  if (s.reconcile && s.reconcile.invariantBreaks > 0) {
    add("PAGE", "INVARIANT_BREAK", null, `reconcile ${s.date}: ${s.reconcile.invariantBreaks} invariant break(s): ${s.reconcile.detail}`);
  }
  return out;
}
