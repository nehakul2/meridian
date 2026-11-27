/**
 * MER-45: finalize, strike, prune and close-book cranks (spec 8; D8, D12, D29; R6.3).
 *
 * - FINALIZE: `finalize_close` for each PROVISIONAL ticker-day once record +
 *   `dispute_window_s` has passed, and for a DISPUTED one once raised +
 *   `dispute_resolution_s` (24 h) has passed. "Already final" is success.
 * - STRIKE_CRANK: once a ticker-day is FINAL (the state `CloseFinalized` announces; the
 *   crank reads it from chain so a missed event cannot stall it), `settle_market` for every
 *   strike, in small batches with priority fees. A repeat is a no-op in the program
 *   (SJ-07). `ConfidenceStraddle` raises a PAGE for the admin path (admin_settle_market) and
 *   the other strikes carry on.
 * - PRUNE: after settlement, `prune_orders` in batches until each book is empty.
 * - CLOSE_BOOK: `close_book` for every settled market whose book is empty.
 * Every step reads chain state first, so all are idempotent and resume where they stopped.
 */
import { coder } from "../chain/idl.js";
import { disputePda } from "../chain/pdas.js";
import { isProgramError, MarketAccount, TickerDayAccount } from "../chain/client.js";
import type { JobName, TickerRow } from "../store/types.js";
import { dateKey, IsoDate } from "../time.js";
import { Deps, errText } from "./common.js";

export interface CrankResult {
  job: JobName;
  /** True when nothing is left for this job on this date. */
  done: boolean;
  perTicker: Record<string, string>;
  sigs: string[];
  /** STRIKE_CRANK: seconds from close_time to the last strike settled (settle SLA). */
  settleSlaS?: number;
}

async function tickerDays(deps: Deps, date: IsoDate): Promise<{ t: TickerRow; td: TickerDayAccount | null }[]> {
  const cfg = await deps.chain.config();
  const onChain = new Set(cfg.tickers.map((t) => t.symbol));
  const tickers = (await deps.store.enabledTickers()).filter((t) => onChain.has(t.symbol));
  const key = dateKey(date);
  return Promise.all(tickers.map(async (t) => ({ t, td: await deps.chain.tickerDay(t.symbol, key) })));
}

async function record(deps: Deps, job: JobName, date: IsoDate, symbol: string, status: "OK" | "RETRY" | "SKIPPED", detail: Record<string, unknown>, sigs: string[]) {
  const run = await deps.store.startJobRun(job, date, symbol);
  await deps.store.finishJobRun(run.id, status, detail, sigs);
}

export async function runFinalize(deps: Deps, date: IsoDate): Promise<CrankResult> {
  const res: CrankResult = { job: "FINALIZE", done: true, perTicker: {}, sigs: [] };
  const cfg = await deps.chain.config();
  const now = deps.clock.now();
  for (const { t, td } of await tickerDays(deps, date)) {
    if (!td) continue;
    if (td.status === "Final") {
      res.perTicker[t.symbol] = "FINAL";
      continue;
    }
    if (td.status === "Open") {
      res.perTicker[t.symbol] = "NOT_RECORDED";
      res.done = false;
      continue;
    }
    let due: number;
    if (td.status === "Provisional") {
      due = td.recordedAt + cfg.disputeWindowS;
    } else {
      const d = await deps.chain.reader.getAccount(disputePda(td.address));
      const raisedAt = d ? Number((coder.accounts.decode("Dispute", Buffer.from(d.data)) as { raised_at: { toString(): string } }).raised_at.toString()) : 0;
      due = raisedAt + cfg.disputeResolutionS;
    }
    if (now < due) {
      res.perTicker[t.symbol] = `${td.status.toUpperCase()}_UNTIL_${due}`;
      res.done = false;
      continue;
    }
    try {
      const sig = await deps.chain.finalizeClose(td);
      res.sigs.push(sig);
      res.perTicker[t.symbol] = "FINALIZED";
      await record(deps, "FINALIZE", date, t.symbol, "OK", { from: td.status }, [sig]);
    } catch (e) {
      if (isProgramError(e, "TickerDayNotOpen")) {
        res.perTicker[t.symbol] = "FINAL";
        continue;
      }
      if (isProgramError(e, "DisputeWindowOpen", "ResolutionDeadlineNotReached")) {
        res.perTicker[t.symbol] = "WAITING";
        res.done = false;
        continue;
      }
      res.done = false;
      res.perTicker[t.symbol] = `ERROR ${errText(e)}`;
      await record(deps, "FINALIZE", date, t.symbol, "RETRY", { error: errText(e) }, []);
    }
  }
  return res;
}

export async function runStrikeCrank(deps: Deps, date: IsoDate, o: { batch?: number } = {}): Promise<CrankResult> {
  const res: CrankResult = { job: "STRIKE_CRANK", done: true, perTicker: {}, sigs: [] };
  const batch = o.batch ?? 4;
  let lastSettledAt = 0;
  let close = 0;
  for (const { t, td } of await tickerDays(deps, date)) {
    if (!td) continue;
    close = td.closeTime;
    if (td.status !== "Final") {
      res.perTicker[t.symbol] = `WAITING_${td.status.toUpperCase()}`;
      res.done = false;
      continue;
    }
    const markets = (await deps.chain.markets(td.address)).filter((m) => m.status !== "Settled" && m.status !== "Void");
    let settled = 0;
    const refused: bigint[] = [];
    const errors: string[] = [];
    const sigs: string[] = [];
    const one = async (m: MarketAccount) => {
      try {
        sigs.push(await deps.chain.settleMarket(m));
        settled++;
      } catch (e) {
        if (isProgramError(e, "ConfidenceStraddle")) {
          refused.push(m.strikeCents);
          await deps.alerter.raise("PAGE", "SETTLE_STRIKE_REFUSED",
            `${t.symbol} strike ${m.strikeCents}c is inside the confidence band of the close; settle via admin_settle_market (multisig).`, t.symbol, date);
        } else {
          errors.push(`${m.strikeCents}: ${errText(e)}`);
        }
      }
    };
    for (let i = 0; i < markets.length; i += batch) {
      const group = markets.slice(i, i + batch);
      try {
        sigs.push(await deps.chain.sender.send(group.map((m) => deps.chain.ixSettleMarket(m)), [deps.chain.keys.payer], {
          priorityMicroLamports: deps.chain.opts.priorityMicroLamports,
        }));
        settled += group.length;
      } catch {
        // One refused or failing strike fails the batch: settle the group one by one.
        for (const m of group) await one(m);
      }
    }
    lastSettledAt = Math.max(lastSettledAt, deps.clock.now());
    res.sigs.push(...sigs);
    res.perTicker[t.symbol] = `settled ${settled}, refused ${refused.length}, errors ${errors.length}`;
    if (errors.length > 0) res.done = false;
    if (markets.length > 0) {
      await record(deps, "STRIKE_CRANK", date, t.symbol, errors.length ? "RETRY" : "OK",
        { settled, refused: refused.map(String), errors }, sigs);
    }
  }
  if (res.done && close > 0 && lastSettledAt > 0) res.settleSlaS = lastSettledAt - close;
  return res;
}

export async function runPrune(deps: Deps, date: IsoDate, o: { maxAccounts?: number; maxCalls?: number } = {}): Promise<CrankResult> {
  const res: CrankResult = { job: "PRUNE", done: true, perTicker: {}, sigs: [] };
  for (const { t, td } of await tickerDays(deps, date)) {
    if (!td) continue;
    let pruned = 0;
    let pending = 0;
    const sigs: string[] = [];
    for (const m of await deps.chain.markets(td.address)) {
      if (m.status !== "Settled" && m.status !== "Void") {
        pending++;
        continue;
      }
      for (let calls = 0; calls < (o.maxCalls ?? 200); calls++) {
        const book = await deps.chain.book(m);
        if (!book || book.orderCount === 0) break;
        const { count, remaining } = deps.chain.pruneBatch(m, book, o.maxAccounts);
        try {
          sigs.push(await deps.chain.pruneOrders(m, count, remaining));
          pruned += count;
        } catch (e) {
          res.done = false;
          deps.log.warn("prune failed; will resume", { market: m.address.toBase58(), error: errText(e) });
          break;
        }
      }
    }
    if (pending > 0) res.done = false;
    res.sigs.push(...sigs);
    res.perTicker[t.symbol] = `pruned ${pruned}, unsettled ${pending}`;
    if (pruned > 0) await record(deps, "PRUNE", date, t.symbol, "OK", { pruned }, sigs);
  }
  return res;
}

export async function runCloseBook(deps: Deps, date: IsoDate): Promise<CrankResult> {
  const res: CrankResult = { job: "CLOSE_BOOK", done: true, perTicker: {}, sigs: [] };
  for (const { t, td } of await tickerDays(deps, date)) {
    if (!td) continue;
    let closed = 0;
    let open = 0;
    const sigs: string[] = [];
    for (const m of await deps.chain.markets(td.address)) {
      const book = await deps.chain.book(m);
      if (!book) continue; // already closed
      if ((m.status !== "Settled" && m.status !== "Void") || book.orderCount > 0) {
        open++;
        continue;
      }
      try {
        sigs.push(await deps.chain.closeBook(m));
        closed++;
      } catch (e) {
        if (isProgramError(e, "BookClosed")) continue;
        open++;
        deps.log.warn("close_book failed; will retry", { market: m.address.toBase58(), error: errText(e) });
      }
    }
    if (open > 0) res.done = false;
    res.sigs.push(...sigs);
    res.perTicker[t.symbol] = `closed ${closed}, still open ${open}`;
    if (closed > 0) await record(deps, "CLOSE_BOOK", date, t.symbol, "OK", { closed }, sigs);
  }
  return res;
}
