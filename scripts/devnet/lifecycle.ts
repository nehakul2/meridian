/**
 * MER-80 `make lifecycle-devnet`: one trading day end to end on a deployed program, with no
 * Meridian server in the path (E2E-01, E2E-06, AGT-10). Every user transaction is built with the
 * same instruction builders as the Tx Builder (services/txb/src/chain/ixs.ts) and sent straight
 * to RPC; settlement uses a real Pyth update stamped at the chosen close time.
 *
 * Steps, in order (each one is a report row with its signatures):
 *   preflight        devnet guard, Config roles match the loaded keys, ticker has a feed
 *   fund             SOL and test USDC for bob (maker), alice and carol (takers)
 *   morning          create_ticker_day + create_strike_market x2 (ATM and ATM + step)
 *   mint-and-quote   bob mints 100 pairs, asks Yes 40 @ 60, bids Yes 40 @ 40
 *   buy-yes          alice Buy Yes 15 (IOC, fills bob's ask @ 60)
 *   sell-yes         alice Sell Yes 10 (IOC, fills bob's bid @ 40)
 *   buy-no           carol Buy No 10 (buy_no_market: sells Yes into bob's bid @ 40)
 *   sell-no          carol Sell No 10 (sell_no: buys Yes from bob's ask @ 60 and merges)
 *   halt-check       after close_time a trade is rejected on-chain (D12)
 *   record-close     first Pyth update at or after close_time, posted and recorded (D1, D3)
 *   finalize         after the dispute window (D8)
 *   settle           settle_market for each strike (D10)
 *   prune-and-close  prune resting orders, withdraw bob's ledger, close the books (D29)
 *   redeem           every holder redeems; losing tokens burn for nothing
 *   verify           balances match the hand calculation; vault >= accounted, then 0 (D17)
 */
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { BOOK_LEN } from "../../services/automation/src/chain/book.js";
import { isProgramError, MarketAccount, MeridianChain, TickerDayAccount } from "../../services/automation/src/chain/client.js";
import { coder } from "../../services/automation/src/chain/idl.js";
import { ata, configPda, tickerDayPda } from "../../services/automation/src/chain/pdas.js";
import { addDays, dateKey, etDate } from "../../services/automation/src/time.js";
import {
  ixBuyNoMarket, ixCreateAtaIdempotent, ixMint, ixPlaceOrder, ixRedeem, ixSellNo, ixWithdraw,
} from "../../services/txb/src/chain/ixs.js";
import type { Cluster } from "./cluster.js";
import { ixFund } from "./cluster.js";
import type { DeploymentRecord } from "./deploy.js";
import type { DevnetKeys } from "./keys.js";
import { ixCreateAta, ixMintTo, tokenAmount } from "./spl.js";

export const MICRO_PER_CENT = 10_000n;
export const MICRO_PER_USDC = 1_000_000n;

/** The scenario's sizes and prices (cents). Hand calculation in `expectedBalances`. */
export const SCENARIO = {
  start: { bob: 10_000n * MICRO_PER_USDC, alice: 1_000n * MICRO_PER_USDC, carol: 1_000n * MICRO_PER_USDC },
  mint: 100n,
  ask: { price: 60, qty: 40n },
  bid: { price: 40, qty: 40n },
  aliceBuy: 15n,
  aliceSell: 10n,
  carolNo: 10n,
} as const;

export type Holder = "bob" | "alice" | "carol";
export type Outcome = "YES" | "NO";

/** Final USDC per holder after everyone redeems, for a settled outcome. Fees are 0 on devnet (D28). */
export function expectedBalances(outcome: Outcome): Record<Holder, bigint> {
  const s = SCENARIO;
  const askPx = BigInt(s.ask.price) * MICRO_PER_CENT;
  const bidPx = BigInt(s.bid.price) * MICRO_PER_CENT;
  const askFilled = s.aliceBuy + s.carolNo; // alice's Buy Yes and carol's Sell No lift the ask
  const bidFilled = s.aliceSell + s.carolNo; // alice's Sell Yes and carol's Buy No hit the bid
  const bobYes = s.mint - askFilled + bidFilled;
  const bobNo = s.mint;
  const aliceYes = s.aliceBuy - s.aliceSell;
  const pay = (yes: bigint, no: bigint) => (outcome === "YES" ? yes : no) * MICRO_PER_USDC;
  return {
    bob: s.start.bob - s.mint * MICRO_PER_USDC + askFilled * askPx - bidFilled * bidPx + pay(bobYes, bobNo),
    alice: s.start.alice - s.aliceBuy * askPx + s.aliceSell * bidPx + pay(aliceYes, 0n),
    // Buy No pays $1 - bid per No; Sell No receives $1 - ask per No.
    carol: s.start.carol - s.carolNo * (MICRO_PER_USDC - bidPx) + s.carolNo * (MICRO_PER_USDC - askPx),
  };
}

export interface StepReport {
  step: string;
  ok: boolean;
  ms: number;
  signatures: string[];
  detail?: Record<string, unknown>;
  error?: string;
}

export interface LifecycleReport {
  ok: boolean;
  cluster: string;
  programId: string;
  ticker: string;
  date: number;
  schedule: { mintOpen: number; open: number; close: number };
  strikes: string[];
  closePrice?: { price: string; expo: number; publishTime: number };
  outcomes?: Record<string, string>;
  balances?: { expected: Record<Holder, string>; actual: Record<Holder, string> };
  steps: StepReport[];
  failedStep?: string;
}

export class StepFailed extends Error {
  constructor(readonly step: string, readonly cause: unknown, readonly report: LifecycleReport) {
    super(`lifecycle failed at step '${step}': ${(cause as Error)?.message ?? String(cause)}`);
  }
}

export interface LifecycleOptions {
  cluster: Cluster;
  keys: Omit<DevnetKeys, "deployer">;
  deployment: Pick<DeploymentRecord, "usdcMint" | "programId">;
  ticker: string;
  /** Trading-date key (YYYYMMDD). Default: the first ET date from today with no ticker-day yet. */
  date?: number;
  /** Explicit on-chain times (a calendar day in tests). Default: trading opens now for `tradeWindowS`. */
  schedule?: { mintOpen: number; open: number; close: number };
  tradeWindowS?: number;
  /** Strikes in cents. Default: the current Pyth price rounded to $1, and that + `strikeStepCents`. */
  strikes?: bigint[];
  strikeStepCents?: bigint;
  /** Holders who keep their tokens (redeemed later, e.g. on the next day: E2E-07). */
  skipRedeem?: Holder[];
  /** Reuse these users (fresh ones are generated otherwise). */
  users?: Partial<Record<Holder, Keypair>>;
  log?: (m: string) => void;
}

export interface LifecycleResult {
  report: LifecycleReport;
  users: Record<Holder, Keypair>;
  markets: MarketAccount[];
}

const HALT_ERRORS = ["MarketHalted", "MarketClosed", "MarketNotOpen"];

/** First trading-date key at or after today (ET) whose ticker-day does not exist yet. */
export async function freshDateKey(cluster: Cluster, ticker: string, now: number): Promise<number> {
  let iso = etDate(now);
  for (let i = 0; i < 400; i++) {
    const key = dateKey(iso);
    if (!(await cluster.reader.getAccount(tickerDayPda(ticker, key)))) return key;
    iso = addDays(iso, 1);
  }
  throw new Error(`no free trading-date key for ${ticker} in the next 400 days`);
}

export async function runLifecycle(o: LifecycleOptions): Promise<LifecycleResult> {
  const log = o.log ?? (() => {});
  const { cluster, keys } = o;
  const usdc = new PublicKey(o.deployment.usdcMint);
  const chain = new MeridianChain(cluster.reader, cluster.sender, { payer: keys.payer, creator: keys.creator, settler: keys.settler });
  const users: Record<Holder, Keypair> = {
    bob: o.users?.bob ?? Keypair.generate(),
    alice: o.users?.alice ?? Keypair.generate(),
    carol: o.users?.carol ?? Keypair.generate(),
  };
  const report: LifecycleReport = {
    ok: false, cluster: cluster.kind, programId: o.deployment.programId, ticker: o.ticker, date: o.date ?? 0,
    schedule: { mintOpen: 0, open: 0, close: 0 }, strikes: [], steps: [],
  };

  const step = async <T>(name: string, fn: (sigs: string[]) => Promise<T>, detail?: (r: T) => Record<string, unknown>): Promise<T> => {
    const t0 = Date.now();
    const sigs: string[] = [];
    log(`> ${name}`);
    try {
      const r = await fn(sigs);
      report.steps.push({ step: name, ok: true, ms: Date.now() - t0, signatures: sigs, detail: detail?.(r) });
      return r;
    } catch (e) {
      report.steps.push({ step: name, ok: false, ms: Date.now() - t0, signatures: sigs, error: (e as Error)?.message ?? String(e) });
      report.failedStep = name;
      throw new StepFailed(name, e, report);
    }
  };
  const send = async (sigs: string[], ixs: TransactionInstruction[], signers: Keypair[], computeUnits?: number) => {
    sigs.push(await cluster.sender.send(ixs, signers, computeUnits ? { computeUnits } : {}));
  };

  // ---- preflight ----
  const pre = await step("preflight", async () => {
    await cluster.assertSafe();
    const raw = await cluster.reader.getAccount(configPda());
    if (!raw) throw new Error("Config is not initialised: run `make deploy-devnet` first");
    const cfg = await chain.config(true);
    const d = coder.accounts.decode("Config", Buffer.from(raw.data)) as Record<string, any>;
    if (!cfg.marketCreator.equals(keys.creator.publicKey)) throw new Error("loaded market_creator key is not Config.market_creator");
    if (!cfg.settler.equals(keys.settler.publicKey)) throw new Error("loaded settler key is not Config.settler");
    if (!cfg.usdcMint.equals(usdc)) throw new Error(`Config USDC mint ${cfg.usdcMint} differs from the deployment record ${usdc}`);
    if (cfg.paused) throw new Error("program is paused");
    const t = cfg.tickers.find((x) => x.symbol === o.ticker);
    if (!t) throw new Error(`ticker ${o.ticker} is not in Config`);
    return { cfg, feedHex: t.feedId.toString("hex"), attested: Object.keys(d.close_source_mode as object)[0]?.toLowerCase() === "attestedchecked" };
  }, (r) => ({ feed: r.feedHex, disputeWindowS: r.cfg.disputeWindowS, settleWindowS: r.cfg.settleWindowS }));

  const now0 = await cluster.now();
  const date = o.date ?? (await freshDateKey(cluster, o.ticker, now0));
  report.date = date;
  const tradeWindow = o.tradeWindowS ?? 240;
  const sched = o.schedule ?? { mintOpen: now0 - 60, open: now0, close: now0 + tradeWindow };
  report.schedule = sched;

  // ---- fund ----
  const startUsdc = { ...SCENARIO.start } as Record<Holder, bigint>;
  await step("fund", async (sigs) => {
    // The automation payer pays each new market's rent (~0.65 SOL for the order book); close_book
    // returns that rent to market_creator (D29), so top the payer up from the creator when short.
    const perMarket = (await cluster.rentExempt(BOOK_LEN)) + 30_000_000;
    const need = perMarket * (o.strikes?.length ?? 2) + 500_000_000;
    const have = await cluster.lamports(keys.payer.publicKey);
    if (have < need) {
      const spare = (await cluster.lamports(keys.creator.publicKey)) - 50_000_000;
      if (have + Math.max(0, spare) < need) {
        throw new Error(`automation payer ${keys.payer.publicKey.toBase58()} has ${have / 1e9} SOL, needs ${need / 1e9}: fund it`);
      }
      await send(sigs, [ixFund(keys.creator, keys.payer.publicKey, need - have)], [keys.creator]);
    }
    const ixs: TransactionInstruction[] = [];
    for (const h of ["bob", "alice", "carol"] as const) {
      const u = users[h].publicKey;
      if ((await cluster.lamports(u)) < 50_000_000) ixs.push(ixFund(keys.payer, u, 100_000_000));
      ixs.push(ixCreateAta(keys.payer.publicKey, u, usdc));
      const have = tokenAmount((await cluster.reader.getAccount(ata(u, usdc)))?.data);
      if (have < SCENARIO.start[h]) ixs.push(ixMintTo(usdc, ata(u, usdc), keys.payer.publicKey, SCENARIO.start[h] - have));
    }
    await send(sigs, ixs, [keys.payer]);
    for (const h of ["bob", "alice", "carol"] as const) startUsdc[h] = tokenAmount((await cluster.reader.getAccount(ata(users[h].publicKey, usdc)))?.data);
  });

  // ---- morning ----
  const strikes = o.strikes ?? (await (async () => {
    const latest = await cluster.oracle.latest(pre.feedHex);
    if (!latest) throw new StepFailed("morning", new Error(`no Pyth price for ${o.ticker}`), report);
    const cents = scaleToCents(latest.priceRaw, latest.expo);
    const atm = ((cents + 50n) / 100n) * 100n;
    return [atm, atm + (o.strikeStepCents ?? 500n)];
  })());
  report.strikes = strikes.map(String);
  const markets = await step("morning", async (sigs) => {
    sigs.push(await chain.createTickerDay(o.ticker, date, sched.mintOpen, sched.open, sched.close));
    for (const s of strikes) sigs.push(await chain.createStrikeMarket(o.ticker, date, s));
    const td = await chain.tickerDay(o.ticker, date);
    if (!td || td.closeTime !== sched.close) throw new Error("ticker-day exists with a different schedule: pass a fresh --date");
    const ms = await chain.markets(td.address);
    if (ms.length !== strikes.length) throw new Error(`expected ${strikes.length} markets, found ${ms.length}`);
    return ms;
  }, (ms) => ({ tickerDay: tickerDayPda(o.ticker, date).toBase58(), markets: ms.map((m) => m.address.toBase58()) }));
  const m = markets[0]!;
  const bob = users.bob, alice = users.alice, carol = users.carol;
  const makers = [bob.publicKey];

  // ---- trading: all four paths on one book ----
  await step("mint-and-quote", async (sigs) => {
    await cluster.waitUntil(Math.max(sched.mintOpen, sched.open), log);
    await send(sigs, [ixMint(bob.publicKey, m, usdc, SCENARIO.mint)], [bob]);
    await send(sigs, [ixPlaceOrder(bob.publicKey, m, usdc, "ASK", SCENARIO.ask.price, SCENARIO.ask.qty, "GTC", 1n, [])], [bob]);
    await send(sigs, [ixPlaceOrder(bob.publicKey, m, usdc, "BID", SCENARIO.bid.price, SCENARIO.bid.qty, "GTC", 2n, [])], [bob]);
  });
  await step("buy-yes", async (sigs) => {
    await send(sigs, [ixPlaceOrder(alice.publicKey, m, usdc, "BID", SCENARIO.ask.price + 5, SCENARIO.aliceBuy, "IOC", 3n, makers)], [alice]);
  });
  await step("sell-yes", async (sigs) => {
    await send(sigs, [ixPlaceOrder(alice.publicKey, m, usdc, "ASK", SCENARIO.bid.price - 5, SCENARIO.aliceSell, "IOC", 4n, makers)], [alice]);
  });
  await step("buy-no", async (sigs) => {
    await send(sigs, [ixBuyNoMarket(carol.publicKey, m, usdc, SCENARIO.carolNo, SCENARIO.bid.price - 5, makers)], [carol]);
  });
  await step("sell-no", async (sigs) => {
    await send(sigs, [ixSellNo(carol.publicKey, m, usdc, SCENARIO.carolNo, SCENARIO.ask.price + 5, makers)], [carol]);
  });

  // ---- close ----
  await step("halt-check", async () => {
    await cluster.waitUntil(sched.close, log);
    try {
      await cluster.sender.send([ixPlaceOrder(alice.publicKey, m, usdc, "BID", 99, 1n, "IOC", 5n, makers)], [alice]);
    } catch (e) {
      if (isProgramError(e, ...HALT_ERRORS)) return (e as { errName?: string }).errName;
      throw e;
    }
    throw new Error("a trade after close_time was accepted");
  }, (err) => ({ rejectedWith: err }));

  const recorded = await step("record-close", async (sigs) => {
    const window = pre.cfg.settleWindowS;
    let u = await cluster.oracle.updateAtOrAfter(pre.feedHex, sched.close);
    for (let i = 0; !u && i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2_000));
      u = await cluster.oracle.updateAtOrAfter(pre.feedHex, sched.close);
    }
    if (!u) throw new Error(`no Pyth update for ${o.ticker} at or after close_time ${sched.close} (equity feeds publish in US market hours only)`);
    if (u.publishTime > sched.close + window) {
      throw new Error(`first Pyth update is at ${u.publishTime}, ${u.publishTime - sched.close}s after close_time; the program allows ${window}s`);
    }
    const td = tickerDayPda(o.ticker, date);
    // On devnet the attested official close is the reference update's own price: there is no
    // vendor print for a synthetic close time, so the cross-check (D3) passes at zero distance.
    const official = pre.attested ? { price: u.priceRaw, expo: u.expo } : null;
    const update = { vaa: u.vaa, publishTime: u.publishTime, priceRaw: u.priceRaw, expo: u.expo, conf: u.conf } as never;
    sigs.push(...(await cluster.poster.postAndConsume(update, pre.feedHex, keys.settler, (acct) => [chain.ixRecordClose(td, acct, official)])));
    return u;
  }, (u) => ({ price: u.priceRaw.toString(), expo: u.expo, conf: u.conf.toString(), publishTime: u.publishTime }));
  report.closePrice = { price: recorded.priceRaw.toString(), expo: recorded.expo, publishTime: recorded.publishTime };

  await step("finalize", async (sigs) => {
    const td = (await chain.tickerDay(o.ticker, date)) as TickerDayAccount;
    await cluster.waitUntil(td.recordedAt + pre.cfg.disputeWindowS, log);
    sigs.push(await chain.finalizeClose(td));
    const after = await chain.tickerDay(o.ticker, date);
    if (after?.status !== "Final") throw new Error(`ticker-day is ${after?.status}, not Final`);
  });

  const outcomes = await step("settle", async (sigs) => {
    const out: Record<string, string> = {};
    for (const mk of markets) {
      sigs.push(await chain.settleMarket(mk));
      const after = await chain.market(mk.address);
      if (after?.status !== "Settled") throw new Error(`market ${mk.strikeCents} is ${after?.status}`);
      out[mk.strikeCents.toString()] = after.outcome.toUpperCase();
    }
    return out;
  }, (r) => r);
  report.outcomes = outcomes;

  await step("prune-and-close", async (sigs) => {
    for (const mk of markets) {
      for (let i = 0; i < 20; i++) {
        const book = await chain.book(mk);
        if (!book || book.orderCount === 0) break;
        const b = chain.pruneBatch(mk, book);
        sigs.push(await chain.pruneOrders(mk, b.count, b.remaining));
      }
    }
    await send(sigs, [ixWithdraw(bob.publicKey, m, usdc)], [bob]);
    for (const mk of markets) sigs.push(await chain.closeBook(mk));
  });

  await step("redeem", async (sigs) => {
    for (const h of ["bob", "alice", "carol"] as const) {
      if (o.skipRedeem?.includes(h)) continue;
      const sig = await redeemAll(cluster, users[h], m, usdc);
      if (sig) sigs.push(sig);
    }
  });

  await step("verify", async () => {
    const outcome = outcomes[m.strikeCents.toString()] as Outcome;
    // Hand calculation from the scenario's starting balances, shifted to what each user held
    // when the run started (a reused user may already hold more than the scenario start).
    const base = expectedBalances(outcome);
    const exp = Object.fromEntries((["bob", "alice", "carol"] as const).map((h) => [h, base[h] - SCENARIO.start[h] + startUsdc[h]])) as Record<Holder, bigint>;
    const actual = {} as Record<Holder, bigint>;
    for (const h of ["bob", "alice", "carol"] as const) actual[h] = tokenAmount((await cluster.reader.getAccount(ata(users[h].publicKey, usdc)))?.data);
    report.balances = {
      expected: Object.fromEntries(Object.entries(exp).map(([k, v]) => [k, v.toString()])) as Record<Holder, string>,
      actual: Object.fromEntries(Object.entries(actual).map(([k, v]) => [k, v.toString()])) as Record<Holder, string>,
    };
    const skip = new Set(o.skipRedeem ?? []);
    const wrong = (["bob", "alice", "carol"] as const).filter((h) => !skip.has(h) && exp[h] !== actual[h]);
    if (wrong.length) throw new Error(`balances differ from the hand calculation for ${wrong.join(", ")}: ${JSON.stringify(report.balances)}`);
    const total = startUsdc.bob + startUsdc.alice + startUsdc.carol;
    if (!skip.size && actual.bob + actual.alice + actual.carol !== total) throw new Error("USDC is not conserved across the three users");
    for (const mk of markets) {
      const after = (await chain.market(mk.address))!;
      const vault = tokenAmount((await cluster.reader.getAccount(mk.vault))?.data);
      if (vault < after.collateralAccounted) throw new Error(`vault ${vault} < accounted ${after.collateralAccounted} on ${mk.strikeCents}`);
      if (!skip.size && after.collateralAccounted !== 0n) throw new Error(`accounted collateral ${after.collateralAccounted} left on ${mk.strikeCents}`);
    }
  });

  report.ok = true;
  return { report, users, markets };
}

/** Redeems every Yes and No the user holds in `m` (creating missing token accounts first). */
export async function redeemAll(cluster: Cluster, user: Keypair, m: MarketAccount, usdc: PublicKey): Promise<string | null> {
  const yes = tokenAmount((await cluster.reader.getAccount(ata(user.publicKey, m.yesMint)))?.data);
  const no = tokenAmount((await cluster.reader.getAccount(ata(user.publicKey, m.noMint)))?.data);
  if (yes === 0n && no === 0n) return null;
  return cluster.sender.send(
    [ixCreateAtaIdempotent(user.publicKey, m.yesMint), ixCreateAtaIdempotent(user.publicKey, m.noMint), ixRedeem(user.publicKey, m, usdc, yes, no)],
    [user],
  );
}

/** Pyth price (raw x 10^expo) to whole cents, half-up. */
export function scaleToCents(raw: bigint, expo: number): bigint {
  const e = expo + 2;
  if (e >= 0) return raw * 10n ** BigInt(e);
  const d = 10n ** BigInt(-e);
  return (raw + d / 2n) / d;
}

export function formatReport(r: LifecycleReport): string {
  const lines = [
    `Meridian lifecycle on ${r.cluster}: ${r.ok ? "PASS" : `FAIL at ${r.failedStep}`}`,
    `program ${r.programId}  ticker ${r.ticker}  date ${r.date}  strikes ${r.strikes.join(", ")}`,
    `close ${new Date(r.schedule.close * 1000).toISOString()}` + (r.closePrice ? `  price ${r.closePrice.price}e${r.closePrice.expo} @ ${r.closePrice.publishTime}` : ""),
    "",
    ...r.steps.map((s) => `${s.ok ? "ok  " : "FAIL"} ${s.step.padEnd(16)} ${String(s.ms).padStart(7)} ms  ${s.signatures.join(" ")}${s.error ? `  ${s.error}` : ""}`),
  ];
  if (r.balances) lines.push("", `balances expected ${JSON.stringify(r.balances.expected)}`, `balances actual   ${JSON.stringify(r.balances.actual)}`);
  return lines.join("\n");
}
