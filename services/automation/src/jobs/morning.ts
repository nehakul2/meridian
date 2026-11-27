/**
 * MER-43: morning job (spec 8 MORNING, A25, R5.4). At 08:00 ET on trading days, for each
 * enabled ticker not skipped (D25): previous official close (A14, D3), strike inputs and
 * strikes (MER-49, MER-41), `create_ticker_day`, `create_strike_market` x N (each grown to
 * full size), then the ticker-day ALT in `md:alt:{t}:{d}`.
 *
 * Idempotent: every account is a PDA and is checked before it is created, and the program
 * treats "already exists" as success, so a rerun creates nothing new (MKT-03). Tickers run
 * in parallel and retry with backoff until 09:00 ET; PAGE at 08:45 for any incomplete
 * ticker (MKT-06). Signs with `market_creator` only.
 */
import { PublicKey } from "@solana/web3.js";
import { corporateActionSkip, NotATradingDay } from "../calendar.js";
import { configPda, eventAuthority, marketPda, seeded, tickerDayPda, TOKEN_PROGRAM_ID } from "../chain/pdas.js";
import { PROGRAM_ID } from "../chain/idl.js";
import { fetchFirstUpdateAtOrAfter } from "../oracle/hermes.js";
import { lookupOfficialClose, formatCents } from "../oracle/officialClose.js";
import { freezeStrikeInputs } from "../strikeInputs.js";
import type { TickerRow } from "../store/types.js";
import { dateKey, etToUnix, IsoDate } from "../time.js";
import { backoffS, Deps, errText } from "./common.js";

export interface MorningOptions {
  /** ET wall time of the incomplete-ticker page (08:45). */
  pageAt?: [number, number];
  /** ET wall time retries stop (09:00). */
  deadline?: [number, number];
  backoffBaseS?: number;
  backoffCapS?: number;
  /** Oldest stored official close accepted as previous close when yesterday's is missing (MKT-10). */
  maxPrevCloseAgeDays?: number;
  rand?: () => number;
}

export type TickerOutcome =
  | { symbol: string; status: "OK"; created: number; existing: number; sigs: string[]; strikes: bigint[] }
  | { symbol: string; status: "SKIPPED"; reason: string }
  | { symbol: string; status: "FAILED"; error: string };

export interface MorningResult {
  date: IsoDate;
  status: "OK" | "SKIPPED" | "PARTIAL";
  tickers: TickerOutcome[];
}

class Skip extends Error {}

export async function runMorning(deps: Deps, date: IsoDate, o: MorningOptions = {}): Promise<MorningResult> {
  if (!deps.calendar.isTradingDay(date)) {
    // CAL-01: holiday or weekend; nothing is sent and nothing above INFO is raised.
    const run = await deps.store.startJobRun("MORNING", date, null);
    await deps.store.finishJobRun(run.id, "SKIPPED", { reason: "not a trading day" });
    return { date, status: "SKIPPED", tickers: [] };
  }
  if (deps.corp) {
    const status = await deps.corp.marketStatus(date).catch(() => null);
    if (status === "closed") {
      await deps.alerter.raise("WARN", "CALENDAR_MISMATCH", `Massive reports the market closed on ${date} but trading_calendar has a row`, null, date);
      const run = await deps.store.startJobRun("MORNING", date, null);
      await deps.store.finishJobRun(run.id, "SKIPPED", { reason: "market status closed (Massive)" });
      return { date, status: "SKIPPED", tickers: [] };
    }
  }

  const cfg = await deps.chain.config();
  const onChain = new Set(cfg.tickers.map((t) => t.symbol));
  const tickers = (await deps.store.enabledTickers()).filter((t) => onChain.has(t.symbol));
  const deadline = etToUnix(date, ...(o.deadline ?? [9, 0]));
  const pageAt = etToUnix(date, ...(o.pageAt ?? [8, 45]));

  const outcomes = await Promise.all(tickers.map((t) => runTickerWithRetry(deps, date, t, deadline, pageAt, o)));
  const ok = outcomes.every((x) => x.status !== "FAILED");
  return { date, status: ok ? "OK" : "PARTIAL", tickers: outcomes };
}

async function runTickerWithRetry(
  deps: Deps, date: IsoDate, t: TickerRow, deadline: number, pageAt: number, o: MorningOptions,
): Promise<TickerOutcome> {
  let paged = false;
  for (let attempt = 1; ; attempt++) {
    const run = await deps.store.startJobRun("MORNING", date, t.symbol);
    try {
      const res = await createTicker(deps, date, t, o);
      if (res.status === "SKIPPED") {
        await deps.store.finishJobRun(run.id, "SKIPPED", { reason: res.reason });
        await deps.alerter.raise("INFO", "TICKER_SKIPPED", `${t.symbol} skipped on ${date}: ${res.reason}`, t.symbol, date);
      } else if (res.status === "OK") {
        await deps.store.finishJobRun(run.id, "OK", {
          strikes: res.strikes.map(String), created: res.created, existing: res.existing,
        }, res.sigs);
      }
      return res;
    } catch (e) {
      const msg = errText(e);
      const now = deps.clock.now();
      if (e instanceof Skip) {
        await deps.store.finishJobRun(run.id, "SKIPPED", { reason: msg });
        return { symbol: t.symbol, status: "SKIPPED", reason: msg };
      }
      if (!paged && now >= pageAt) {
        paged = true;
        await deps.alerter.raise("PAGE", "MORNING_INCOMPLETE", `${t.symbol} markets for ${date} still incomplete at 08:45 ET: ${msg}`, t.symbol, date);
      }
      const wait = backoffS(attempt, o.backoffBaseS ?? 5, o.backoffCapS ?? 60, o.rand);
      if (now + wait >= deadline) {
        await deps.store.finishJobRun(run.id, "FAILED", { error: msg });
        await deps.alerter.raise("PAGE", "MORNING_FAILED", `${t.symbol} markets for ${date} not created by 09:00 ET: ${msg}`, t.symbol, date);
        return { symbol: t.symbol, status: "FAILED", error: msg };
      }
      await deps.store.finishJobRun(run.id, "RETRY", { error: msg, retryInS: wait });
      deps.log.warn("morning retry", { symbol: t.symbol, attempt, error: msg, wait });
      await deps.clock.sleep(wait);
    }
  }
}

/** Previous close: the previous trading day's official close (A14, D3, ORC-18). */
async function previousClose(deps: Deps, date: IsoDate, t: TickerRow, o: MorningOptions): Promise<bigint> {
  const prev = deps.calendar.previousTradingDay(date);
  const r = await lookupOfficialClose(deps.store, deps.closes, t.symbol, prev, deps.clock.now());
  if (r.kind === "STORED" || r.kind === "MATCHED") return r.row.priceCents;
  if (r.kind === "MISMATCH") {
    await deps.alerter.raise("PAGE", "PREV_CLOSE_MISMATCH",
      `${t.symbol} previous close for ${prev}: Massive ${formatCents(r.massive)} vs Databento ${formatCents(r.databento)}`, t.symbol, date);
    throw new Skip(`previous close vendors disagree for ${prev}`);
  }
  // MKT-10: yesterday unavailable; use the latest stored official close if recent enough.
  const [latest] = await deps.store.officialClosesBefore(t.symbol, date, 1);
  const maxAge = o.maxPrevCloseAgeDays ?? 5;
  if (latest) {
    let age = 0;
    for (let d = date; d > latest.tradingDate && age <= maxAge; d = deps.calendar.previousTradingDay(d)) age++;
    if (age <= maxAge) {
      await deps.alerter.raise("WARN", "PREV_CLOSE_STALE",
        `${t.symbol}: no official close for ${prev} yet; using ${latest.tradingDate} (${formatCents(latest.priceCents)})`, t.symbol, date);
      return latest.priceCents;
    }
  }
  await deps.alerter.raise("PAGE", "PREV_CLOSE_MISSING", `${t.symbol}: no official close for ${prev}; ticker skipped`, t.symbol, date);
  throw new Skip(`no previous official close for ${prev}`);
}

async function createTicker(deps: Deps, date: IsoDate, t: TickerRow, o: MorningOptions): Promise<TickerOutcome> {
  const skip = await corporateActionSkip(t.symbol, date, await deps.store.corporateActions(date), deps.corp);
  if (skip) return { symbol: t.symbol, status: "SKIPPED", reason: `${skip.kind}: ${skip.detail}` };

  const prevCents = await previousClose(deps, date, t, o);

  // Reference Pyth update at the previous close, kept for audit (MKT-09); never blocks.
  const prev = deps.calendar.previousTradingDay(date);
  try {
    const cfg = await deps.chain.config();
    await fetchFirstUpdateAtOrAfter(deps.store, deps.hermes, {
      symbol: t.symbol, date, purpose: "PREV_CLOSE", feedIdHex: t.pythFeedId,
      targetTime: deps.calendar.closeTime(prev), windowS: cfg.settleWindowS, now: deps.clock.now(),
    });
  } catch (e) {
    deps.log.warn("PREV_CLOSE reference update not stored", { symbol: t.symbol, error: errText(e) });
  }

  const { row, warnings } = await freezeStrikeInputs(
    { store: deps.store, iv: deps.iv, calendar: deps.calendar, log: deps.log, now: () => deps.clock.now() },
    t.symbol, date, prevCents, t.liquidityTierOverride,
  );
  for (const w of warnings) await deps.alerter.raise("WARN", "STRIKE_WARNING", `${t.symbol}: ${w}`, t.symbol, date);

  const key = dateKey(date);
  const sigs: string[] = [];
  let created = 0;
  let existing = 0;
  if (!(await deps.chain.tickerDay(t.symbol, key))) {
    sigs.push(await deps.chain.createTickerDay(
      t.symbol, key, deps.calendar.mintOpenTime(date), deps.calendar.openTime(date), deps.calendar.closeTime(date),
    ));
  }
  for (const strike of row.strikesCents) {
    const m = marketPda(t.symbol, key, strike);
    if (await deps.chain.reader.getAccount(m)) {
      existing++;
      continue;
    }
    sigs.push(await deps.chain.createStrikeMarket(t.symbol, key, strike));
    created++;
  }

  if (deps.alt && deps.kv) {
    const altKey = `md:alt:${t.symbol}:${key}`;
    if (!(await deps.kv.get(altKey))) {
      const cfg = await deps.chain.config();
      const td = tickerDayPda(t.symbol, key);
      const addrs: PublicKey[] = [td, configPda(), cfg.usdcMint, eventAuthority(), PROGRAM_ID, TOKEN_PROGRAM_ID];
      for (const strike of row.strikesCents) {
        const m = marketPda(t.symbol, key, strike);
        addrs.push(m, seeded("yes", m), seeded("no", m), seeded("vault", m), seeded("book", m), seeded("base", m), seeded("quote", m));
      }
      const alt = await deps.alt.create(addrs);
      sigs.push(...alt.sigs);
      await deps.kv.set(altKey, alt.table.toBase58(), 7 * 86_400);
    }
  }
  return { symbol: t.symbol, status: "OK", created, existing, sigs, strikes: row.strikesCents };
}

export { NotATradingDay };
