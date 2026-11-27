// MER-45: finalize, strike, prune and close-book cranks against the real program on LiteSVM.
import { TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { coder, metas, PROGRAM_ID } from "../src/chain/idl.js";
import { ata, configPda, ledgerPda, disputePda, eventAuthority, marketPda, tickerDayPda, TOKEN_PROGRAM_ID } from "../src/chain/pdas.js";
import { runCloseBook, runFinalize, runPrune, runStrikeCrank } from "../src/jobs/cranks.js";
import { runMorning } from "../src/jobs/morning.js";
import { runSettle } from "../src/jobs/settler.js";
import { etToUnix } from "../src/time.js";
import { FakeClock, makeDeps } from "./helpers/fakes.js";
import { haveProgram, MAG7, SvmEnv } from "./helpers/svm.js";
import { SystemProgram } from "@solana/web3.js";

const DATE = "2026-11-25";
const CLOSE = etToUnix(DATE, 16, 0);
const KEY = 20261125;
const USDC = 1_000_000n;

/** Markets created for `symbols`, trading open, settler ready. */
async function setup(symbols = ["META"]) {
  const clock = new FakeClock(etToUnix(DATE, 8, 0));
  const env = new SvmEnv(clock);
  const ctx = makeDeps({ clock, chain: env.chain(), poster: env });
  ctx.store.tickers = ctx.store.tickers.filter((t) => symbols.includes(t.symbol));
  for (const t of ctx.store.tickers) t.liquidityTierOverride = "A";
  for (const s of symbols) {
    ctx.massive.set(s, "2026-11-24", 68000n);
    ctx.databento.set(s, "2026-11-24", 68000n);
  }
  await runMorning(ctx.deps, DATE);
  clock.t = etToUnix(DATE, 10, 0);
  return { clock, env, ...ctx };
}

/** Records `cents` (conf in bps) for every ticker at close + 5 min. */
async function record(s: Awaited<ReturnType<typeof setup>>, cents: bigint, confBps = 1n) {
  s.clock.t = CLOSE + 300;
  for (const t of s.store.tickers) {
    s.massive.set(t.symbol, DATE, cents);
    s.databento.set(t.symbol, DATE, cents);
    const price = cents * 1000n;
    s.hermes.add(t.symbol, { price, conf: (price * confBps) / 10_000n, publishTime: CLOSE + 1 });
  }
  const out = await runSettle(s.deps, DATE);
  expect(out.every((o) => o.status === "RECORDED")).toBe(true);
}

describe.skipIf(!haveProgram)("cranks", () => {
  it("SJ-01 / DSP-01 finalize after the 20-minute window, then every strike settles within 5 min", async () => {
    const s = await setup(MAG7);
    await record(s, 68512n);
    const recordedAt = (await s.deps.chain.tickerDay("META", KEY))!.recordedAt;
    // One second before the window ends: nothing to finalize yet.
    s.clock.t = recordedAt + 1199;
    const early = await runFinalize(s.deps, DATE);
    expect(early.done).toBe(false);
    expect((await s.deps.chain.tickerDay("META", KEY))!.status).toBe("Provisional");
    expect(s.env.sent.filter((x) => x.ixs.some((ix) => ix.data.equals(coder.instruction.encode("finalize_close", {}))))).toHaveLength(0);
    // At the window end: all FINAL (UNDISPUTED).
    s.clock.t = recordedAt + 1200;
    const fin = await runFinalize(s.deps, DATE);
    expect(fin.done).toBe(true);
    for (const sym of MAG7) {
      const td = await s.deps.chain.tickerDay(sym, KEY);
      expect([td!.status, td!.finalBasis]).toEqual(["Final", "Undisputed"]);
    }
    // Strike crank on CloseFinalized: every market settled.
    s.clock.t += 60;
    const crank = await runStrikeCrank(s.deps, DATE);
    expect(crank.done).toBe(true);
    let n = 0;
    for (const sym of MAG7) {
      for (const m of await s.deps.chain.markets(tickerDayPda(sym, KEY))) {
        expect(m.status).toBe("Settled");
        expect(m.outcome).toBe(m.strikeCents <= 68512n ? "Yes" : "No");
        n++;
      }
    }
    expect(n).toBe(63);
    expect(crank.settleSlaS).toBeLessThanOrEqual(1800 + 300 + 60);
    expect((await s.store.jobRuns(DATE, "STRIKE_CRANK")).every((r) => r.status === "OK")).toBe(true);
  });

  it("SJ-07 'already settled' is success: two cranks at once, each market settled once, no alerts", async () => {
    const s = await setup();
    await record(s, 68512n);
    s.clock.t += 1200;
    await runFinalize(s.deps, DATE);
    const [a, b] = await Promise.all([runStrikeCrank(s.deps, DATE), runStrikeCrank(s.deps, DATE)]);
    expect(a.done && b.done).toBe(true);
    const again = await runStrikeCrank(s.deps, DATE);
    expect(again.sigs).toHaveLength(0); // rerun is a no-op
    expect(await s.store.alerts()).toEqual([]);
    for (const m of await s.deps.chain.markets(tickerDayPda("META", KEY))) expect(m.status).toBe("Settled");
  });

  it("a strike inside the confidence band is refused with a PAGE for the admin path; the others settle", async () => {
    const s = await setup();
    await record(s, 68000n, 5n); // close exactly at the 680 strike, conf 5 bps
    s.clock.t += 1200;
    await runFinalize(s.deps, DATE);
    const crank = await runStrikeCrank(s.deps, DATE);
    expect(crank.done).toBe(true); // nothing the crank can still do; the multisig owns it
    const markets = await s.deps.chain.markets(tickerDayPda("META", KEY));
    expect(markets.find((m) => m.strikeCents === 68000n)!.status).not.toBe("Settled");
    expect(markets.filter((m) => m.status === "Settled")).toHaveLength(8);
    const page = (await s.store.alerts()).find((a) => a.code === "SETTLE_STRIKE_REFUSED")!;
    expect(page.severity).toBe("PAGE");
    expect(page.message).toMatch(/68000c.*admin_settle_market/);
  });

  it("DSP-06 a dispute left unresolved finalizes at raised + 24 h with the bond returned", async () => {
    const s = await setup();
    await record(s, 68512n);
    const td = tickerDayPda("META", KEY);
    const disputer = s.env.user(500n * USDC);
    s.clock.t += 60;
    const cfg = await s.deps.chain.config();
    s.env.sendSync([new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: metas("raise_dispute", {
        disputer: disputer.publicKey, config: configPda(), ticker_day: td, dispute: disputePda(td),
        disputer_usdc: ata(disputer.publicKey, s.env.usdcMint), bond_vault: cfg.bondVault, token_program: TOKEN_PROGRAM_ID,
        system_program: SystemProgram.programId, event_authority: eventAuthority(),
      }),
      data: coder.instruction.encode("raise_dispute", { evidence_hash: Array(32).fill(9) }),
    })], [disputer]);
    const raisedAt = s.clock.now();
    expect(s.env.tokenBalance(ata(disputer.publicKey, s.env.usdcMint))).toBe(400n * USDC);
    s.clock.t = raisedAt + 86_400 - 1;
    expect((await runFinalize(s.deps, DATE)).done).toBe(false);
    expect((await s.deps.chain.tickerDay("META", KEY))!.status).toBe("Disputed");
    expect((await runStrikeCrank(s.deps, DATE)).done).toBe(false); // nothing settles while DISPUTED
    s.clock.t = raisedAt + 86_400;
    expect((await runFinalize(s.deps, DATE)).done).toBe(true);
    const t = await s.deps.chain.tickerDay("META", KEY);
    expect([t!.status, t!.finalBasis, t!.price]).toEqual(["Final", "Deadline", 68512000n]);
    expect(s.env.tokenBalance(ata(disputer.publicKey, s.env.usdcMint))).toBe(500n * USDC);
  });

  it("CLN-07 prune loops until every book is empty, then every book closes; reruns are no-ops", async () => {
    const s = await setup();
    const m680 = (await s.deps.chain.market(marketPda("META", KEY, 68000n)))!;
    const m700 = (await s.deps.chain.market(marketPda("META", KEY, 70000n)))!;
    // 30 makers resting on M680 (asks and bids) and a BUY_NO limit; one ask on M700.
    const makers = Array.from({ length: 30 }, () => s.env.user(1_000n * USDC));
    makers.forEach((u, i) => {
      s.env.mintPair(u, m680, 5n); // also opens the maker's Yes and No accounts
      if (i % 2 === 0) {
        s.env.place(u, m680, "ask", 60 + (i % 8), 5n);
      } else {
        s.env.place(u, m680, "bid", 30 + (i % 8), 3n);
      }
    });
    const buyNo = s.env.user(1_000n * USDC);
    s.env.mintPair(buyNo, m680, 1n);
    s.env.buyNoLimit(buyNo, m680, 70, 4n);
    const other = s.env.user(1_000n * USDC);
    s.env.mintPair(other, m700, 2n);
    s.env.place(other, m700, "ask", 55, 2n);
    expect((await s.deps.chain.book(m680))!.orderCount).toBe(31);

    await record(s, 68512n);
    s.clock.t += 1200;
    await runFinalize(s.deps, DATE);
    await runStrikeCrank(s.deps, DATE);

    const prune = await runPrune(s.deps, DATE, { maxAccounts: 10 });
    expect(prune.done).toBe(true);
    expect(prune.sigs.length).toBeGreaterThanOrEqual(4); // batched by accounts per tx
    for (const m of await s.deps.chain.markets(tickerDayPda("META", KEY))) expect((await s.deps.chain.book(m))!.orderCount).toBe(0);

    const close = await runCloseBook(s.deps, DATE);
    expect(close.done).toBe(true);
    expect(close.sigs).toHaveLength(9);
    for (const m of await s.deps.chain.markets(tickerDayPda("META", KEY))) expect(await s.deps.chain.book(m)).toBeNull();

    const sent = s.env.sent.length;
    expect((await runPrune(s.deps, DATE)).done).toBe(true);
    expect((await runCloseBook(s.deps, DATE)).done).toBe(true);
    expect(s.env.sent.length).toBe(sent);
    // BUY_NO owner got $1.00 per unfilled pair on the ledger (D15) instead of loose Yes + No.
    const ledger = await s.deps.chain.reader.getAccount(ledgerPda(m680.address, buyNo.publicKey));
    const l = coder.accounts.decode("UserLedger", Buffer.from(ledger!.data)) as { free_usdc: { toString(): string }; locked_yes: { toString(): string } };
    expect(BigInt(l.free_usdc.toString())).toBe(4n * USDC);
    expect(l.locked_yes.toString()).toBe("0");
    const runs = await s.store.jobRuns(DATE);
    expect(runs.some((r) => r.job === "PRUNE" && r.status === "OK")).toBe(true);
    expect(runs.some((r) => r.job === "CLOSE_BOOK" && r.status === "OK")).toBe(true);
  });

  it("partial failure resumes where it stopped", async () => {
    const s = await setup();
    await record(s, 68512n);
    s.clock.t += 1200;
    await runFinalize(s.deps, DATE);
    // The first two settle sends fail at the RPC layer (batch, then its first single).
    s.env.faults.push({ kind: "FAIL_BEFORE" }, { kind: "FAIL_BEFORE" });
    const first = await runStrikeCrank(s.deps, DATE);
    expect(first.done).toBe(false);
    const settledAfterFirst = (await s.deps.chain.markets(tickerDayPda("META", KEY))).filter((m) => m.status === "Settled").length;
    expect(settledAfterFirst).toBe(8);
    const second = await runStrikeCrank(s.deps, DATE);
    expect(second.done).toBe(true);
    expect((await s.deps.chain.markets(tickerDayPda("META", KEY))).every((m) => m.status === "Settled")).toBe(true);
    // Close book refuses an unsettled market: nothing closes before settlement.
  });

  it("close_book waits for settlement; prune does not run before it", async () => {
    const s = await setup();
    await record(s, 68512n);
    const prune = await runPrune(s.deps, DATE);
    const close = await runCloseBook(s.deps, DATE);
    expect(prune.done).toBe(false);
    expect(close.done).toBe(false);
    expect(close.sigs).toHaveLength(0);
  });
});
