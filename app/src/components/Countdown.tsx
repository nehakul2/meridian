"use client";
/** MER-75: countdown to close on the server clock, and the phase banner. */
import { formatCountdown } from "@/lib/clock";
import { etTime } from "@/lib/format";
import { useServerNow, useStatus } from "@/lib/status";
import type { Phase, Status } from "@/lib/types";

export function Countdown({ closeTimeUnix, compact }: { closeTimeUnix: number | null | undefined; compact?: boolean }) {
  const now = useServerNow(1000);
  const { synced } = useStatus();
  if (!closeTimeUnix || !synced) return null;
  const left = closeTimeUnix * 1000 - now;
  const closed = left <= 0;
  const urgent = !closed && left < 15 * 60_000;
  return (
    <span className={`countdown${urgent ? " urgent" : ""}${closed ? " closed" : ""}`} data-testid="countdown" title={`Closes ${etTime(closeTimeUnix)}`}>
      {closed ? "Closed" : compact ? formatCountdown(left) : `Closes in ${formatCountdown(left)}`}
    </span>
  );
}

export function phaseCopy(s: Pick<Status, "phase" | "openTime" | "closeTime" | "paused">): { tone: "info" | "ok" | "warn" | "danger"; title: string; body: string } {
  const open = s.openTime ? etTime(s.openTime) : "9:30 AM ET";
  const close = s.closeTime ? etTime(s.closeTime) : "4:00 PM ET";
  const map: Record<Phase, { tone: "info" | "ok" | "warn" | "danger"; title: string; body: string }> = {
    PRE_OPEN: { tone: "info", title: "Pre-open", body: `Today's contracts are being created. Trading opens at ${open}.` },
    MINT_ONLY: { tone: "info", title: "Minting only", body: `You can mint Yes + No pairs now. The order book opens at ${open}.` },
    TRADING: { tone: "ok", title: "Trading", body: `Markets are open until ${close}.` },
    HALTED: { tone: "warn", title: "Trading closed", body: `Trading stopped at ${close}. Waiting for the official closing price.` },
    SETTLING: { tone: "warn", title: "Settling", body: "Closing prices are being recorded. Outcomes appear ticker by ticker." },
    PROVISIONAL: { tone: "warn", title: "Provisional", body: "Closing prices are recorded and can be disputed until the window ends. Redemption opens when they are final." },
    DISPUTED: { tone: "danger", title: "Disputed", body: "A closing price is under dispute. Affected markets settle after the dispute is resolved." },
    SETTLED: { tone: "ok", title: "Settled", body: "All markets are settled. Winning tokens redeem for $1.00 each in your portfolio." },
    CLOSED_DAY: { tone: "info", title: "Market closed", body: "No trading today. Contracts list again on the next trading day." },
  };
  return map[s.phase];
}

export function PhaseBanner() {
  const { status } = useStatus();
  if (!status) return null;
  if (status.paused) {
    return (
      <div className="banner banner-danger" role="status" data-testid="phase-banner" data-phase="PAUSED">
        <strong>Paused.</strong> New orders and mints are paused by the protocol. Cancels, merges, claims and redemptions still work.
      </div>
    );
  }
  const c = phaseCopy(status);
  return (
    <div className={`banner banner-${c.tone}`} role="status" data-testid="phase-banner" data-phase={status.phase}>
      <span className={`dot dot-${c.tone}`} />
      <strong>{c.title}.</strong> <span>{c.body}</span>
      {status.phase === "TRADING" || status.phase === "MINT_ONLY" ? <span className="banner-right"><Countdown closeTimeUnix={status.closeTimeUnix} /></span> : null}
    </div>
  );
}
