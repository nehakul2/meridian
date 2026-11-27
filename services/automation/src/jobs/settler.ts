/**
 * MER-44: settler job (spec 2.3, 4.7, 8 SETTLE; D1, D2, D3, D13).
 *
 * At close + 5 min, per ticker in parallel:
 * 1. Official closing-auction print from Massive and Databento; they must match exactly.
 *    A mismatch escalates at once and nothing is written (SJ-10). A vendor that has not
 *    published is polled until close + 15 min; the settler never substitutes the last trade
 *    or a later tick (ORC-17).
 * 2. The reference Pyth update: the first at or after close_time, within ε, stored once.
 * 3. Post the stored update bytes and call `record_close` with the official close at the
 *    update's exponent.
 * Retries every 30 s until close + 15 min resubmit the identical stored close and update
 * bytes (D2, SJ-02); WARN at the first failed attempt (close + 5), PAGE at close + 15 with
 * "admin override needed" (SJ-05). "Already recorded" is success (CON-07). Signs with the
 * `settler` key only.
 */
import { isProgramError, ProgramError } from "../chain/client.js";
import { fetchFirstUpdateAtOrAfter, NoUpdateYet, UpdateOutOfWindow } from "../oracle/hermes.js";
import { centsAtExpo, formatCents, lookupOfficialClose } from "../oracle/officialClose.js";
import type { TickerRow } from "../store/types.js";
import { dateKey, IsoDate } from "../time.js";
import { Deps, errText } from "./common.js";

export interface SettleOptions {
  startAfterCloseS?: number;
  deadlineAfterCloseS?: number;
  retryEveryS?: number;
  jitterS?: number;
  priorityMicroLamports?: number;
  rand?: () => number;
}

export type SettleOutcome = {
  symbol: string;
  status: "RECORDED" | "ALREADY_RECORDED" | "FAILED" | "ESCALATED" | "SKIPPED";
  attempts: number;
  detail: string;
  sigs: string[];
};

class Escalate extends Error {}

export async function runSettle(deps: Deps, date: IsoDate, o: SettleOptions = {}): Promise<SettleOutcome[]> {
  if (!deps.calendar.isTradingDay(date)) return [];
  const cfg = await deps.chain.config();
  const onChain = new Set(cfg.tickers.map((t) => t.symbol));
  const tickers = (await deps.store.enabledTickers()).filter((t) => onChain.has(t.symbol));
  const close = deps.calendar.closeTime(date);
  const start = close + (o.startAfterCloseS ?? 300);
  if (deps.clock.now() < start) await deps.clock.sleep(start - deps.clock.now());
  // SJ-06: tickers are independent; one failing never blocks the others.
  return Promise.all(tickers.map((t) => settleTicker(deps, date, t, close, o)));
}

async function settleTicker(deps: Deps, date: IsoDate, t: TickerRow, close: number, o: SettleOptions): Promise<SettleOutcome> {
  const deadline = close + (o.deadlineAfterCloseS ?? 900);
  const every = o.retryEveryS ?? 30;
  const jitter = o.jitterS ?? 3;
  const rand = o.rand ?? Math.random;
  const settler = deps.chain.keys.settler;
  if (!settler) throw new Error("settler key not loaded");
  if (!deps.poster) throw new Error("price update poster not configured");
  const key = dateKey(date);
  let warned = false;
  let lastReason = "";

  for (let attempt = 1; ; attempt++) {
    const run = await deps.store.startJobRun("SETTLE", date, t.symbol);
    const finish = async (status: "OK" | "FAILED" | "SKIPPED" | "RETRY", out: SettleOutcome) => {
      await deps.store.finishJobRun(run.id, status, { result: out.status, detail: out.detail }, out.sigs);
      return out;
    };
    try {
      const td = await deps.chain.tickerDay(t.symbol, key);
      if (!td) {
        return finish("SKIPPED", { symbol: t.symbol, status: "SKIPPED", attempts: attempt, detail: "no ticker-day on chain", sigs: [] });
      }
      if (td.status !== "Open") {
        // SJ-09, CON-07: already recorded (by us earlier, a twin instance or the admin path).
        return finish("OK", { symbol: t.symbol, status: "ALREADY_RECORDED", attempts: attempt, detail: td.status, sigs: [] });
      }

      const oc = await lookupOfficialClose(deps.store, deps.closes, t.symbol, date, deps.clock.now());
      if (oc.kind === "MISMATCH") {
        const msg = `${t.symbol} official close disagrees: Massive ${formatCents(oc.massive)} vs Databento ${formatCents(oc.databento)}. Nothing recorded; Settlement Triage to review; admin path opens at close + override delay.`;
        await deps.alerter.raise("PAGE", "SETTLE_VENDOR_MISMATCH", msg, t.symbol, date);
        throw new Escalate(msg);
      }
      if (oc.kind === "PENDING") {
        const missing = [oc.massive === null ? "Massive" : null, oc.databento === null ? "Databento" : null].filter(Boolean).join(" and ");
        throw new Error(`official close not yet published by ${missing}${oc.errors.length ? ` (${oc.errors.join("; ")})` : ""}`);
      }

      const cfg = await deps.chain.config();
      const update = await fetchFirstUpdateAtOrAfter(deps.store, deps.hermes, {
        symbol: t.symbol, date, purpose: "SETTLE", feedIdHex: t.pythFeedId, targetTime: close,
        windowS: cfg.settleWindowS, now: deps.clock.now(),
      });
      const official = { price: centsAtExpo(oc.row.priceCents, update.expo), expo: update.expo };
      try {
        const sigs = await deps.poster.postAndConsume(
          update, t.pythFeedId, settler,
          (acct) => [deps.chain.ixRecordClose(td.address, acct, official)],
          o.priorityMicroLamports,
        );
        return finish("OK", { symbol: t.symbol, status: "RECORDED", attempts: attempt, detail: `official ${formatCents(oc.row.priceCents)}`, sigs });
      } catch (e) {
        if (isProgramError(e, "TickerDayNotOpen")) {
          return finish("OK", { symbol: t.symbol, status: "ALREADY_RECORDED", attempts: attempt, detail: "recorded by another writer", sigs: [] });
        }
        if (isProgramError(e, "CrossCheckFailed")) {
          const msg = `${t.symbol} official close ${formatCents(oc.row.priceCents)} is outside the Pyth tolerance of the reference update (price ${update.priceRaw}e${update.expo}, conf ${update.conf}). Nothing recorded; Settlement Triage to review.`;
          await deps.alerter.raise("PAGE", "SETTLE_CROSS_CHECK_FAILED", msg, t.symbol, date);
          throw new Escalate(msg);
        }
        throw e;
      }
    } catch (e) {
      if (e instanceof Escalate) {
        return finish("FAILED", { symbol: t.symbol, status: "ESCALATED", attempts: attempt, detail: e.message, sigs: [] });
      }
      lastReason = e instanceof ProgramError ? `${e.errName ?? e.code}` :
        e instanceof NoUpdateYet ? "no Pyth update at or after the close yet" :
        e instanceof UpdateOutOfWindow ? e.message : errText(e);
      if (!warned) {
        warned = true;
        await deps.alerter.raise("WARN", "SETTLE_SLA_AT_RISK", `${t.symbol} close not recorded at close + 5 min: ${lastReason}`, t.symbol, date);
      }
      const wait = every + Math.round((rand() * 2 - 1) * jitter);
      if (deps.clock.now() + wait > deadline) {
        await deps.alerter.raise("PAGE", "SETTLE_FAILED",
          `${t.symbol} close for ${date} not recorded by close + 15 min (${lastReason}). Admin override needed.`, t.symbol, date);
        return finish("FAILED", { symbol: t.symbol, status: "FAILED", attempts: attempt, detail: lastReason, sigs: [] });
      }
      await deps.store.finishJobRun(run.id, "RETRY", { error: lastReason, retryInS: wait });
      await deps.clock.sleep(wait);
    }
  }
}
