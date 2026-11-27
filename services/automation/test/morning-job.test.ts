// MER-43: morning job against the real program on LiteSVM.
import { describe, expect, it } from "vitest";
import { marketPda, tickerDayPda } from "../src/chain/pdas.js";
import { runMorning } from "../src/jobs/morning.js";
import { dateKey, etToUnix } from "../src/time.js";
import { FakeClock, makeDeps } from "./helpers/fakes.js";
import { haveProgram, MAG7, SvmEnv } from "./helpers/svm.js";

const DATE = "2026-11-25";
const PREV = "2026-11-24";
const PREV_CLOSES: Record<string, bigint> = {
  AAPL: 23000n, MSFT: 41500n, GOOGL: 17500n, AMZN: 20500n, NVDA: 19000n, META: 68000n, TSLA: 25000n,
};

function setup(at = etToUnix(DATE, 8, 0)) {
  const clock = new FakeClock(at);
  const env = new SvmEnv(clock);
  const ctx = makeDeps({ clock, chain: env.chain() });
  // META at tier A (the spec 8.1 worked example); the others have no fills history -> tier B.
  ctx.store.tickers.find((t) => t.symbol === "META")!.liquidityTierOverride = "A";
  for (const s of MAG7) {
    ctx.massive.set(s, PREV, PREV_CLOSES[s]!);
    ctx.databento.set(s, PREV, PREV_CLOSES[s]!);
    ctx.iv.values.set(s, 3500n);
    // Reference Pyth update at the previous close (MKT-09).
    ctx.hermes.add(s, { price: PREV_CLOSES[s]! * 1000n + 7n, conf: 10_000n, publishTime: etToUnix(PREV, 16, 0) + 1 });
    ctx.hermes.add(s, { price: PREV_CLOSES[s]! * 1000n + 9n, conf: 10_000n, publishTime: etToUnix(PREV, 16, 0) + 3 });
  }
  return { clock, env, ...ctx };
}

describe.skipIf(!haveProgram)("morning job", () => {
  it("MKT-05 creates every ticker-day and the generated strikes, with an ALT per ticker-day", async () => {
    const s = setup();
    const altTables: number[] = [];
    s.deps.alt = { create: async (addrs) => { altTables.push(addrs.length); return { table: s.env.payer.publicKey, sigs: ["alt"] }; } };
    const res = await runMorning(s.deps, DATE);
    expect(res.status).toBe("OK");
    for (const t of res.tickers) expect(t.status).toBe("OK");
    for (const sym of MAG7) {
      const td = await s.deps.chain.tickerDay(sym, dateKey(DATE));
      expect(td?.status).toBe("Open");
      const inputs = await s.store.getStrikeInputs(sym, DATE);
      const markets = await s.deps.chain.markets(tickerDayPda(sym, dateKey(DATE)));
      expect(markets.map((m) => m.strikeCents)).toEqual(inputs!.strikesCents);
      expect(td!.strikeCount).toBe(inputs!.strikesCents.length);
      expect(await s.kv.get(`md:alt:${sym}:20261125`)).toBe(s.env.payer.publicKey.toBase58());
      // Each book is grown to full size in the creating transaction.
      const book = await s.deps.chain.book(markets[0]!);
      expect(book?.orderCount).toBe(0);
    }
    const meta = await s.store.getStrikeInputs("META", DATE);
    expect(meta!.strikesCents).toEqual([64000n, 65000n, 66000n, 67000n, 68000n, 69000n, 70000n, 71000n, 72000n]);
    expect(altTables).toHaveLength(7);
    expect(altTables).toContain(6 + 7 * 9); // META: 6 shared accounts + 7 per strike
    // Times on chain come from the calendar (D26): 08:30 mint, 09:30 open, 16:00 close.
    const td = await s.deps.chain.tickerDay("META", 20261125);
    expect([td!.mintOpenTime, td!.openTime, td!.closeTime]).toEqual([etToUnix(DATE, 8, 30), etToUnix(DATE, 9, 30), etToUnix(DATE, 16, 0)]);
    // job_runs carry the signatures; everything signed by market_creator + fee payer only.
    const runs = await s.store.jobRuns(DATE, "MORNING");
    expect(runs.filter((r) => r.status === "OK")).toHaveLength(7);
    expect(runs.every((r) => r.txSigs.length > 0)).toBe(true);
    const signers = new Set(s.env.sent.flatMap((x) => x.signers));
    expect([...signers].sort()).toEqual([s.env.payer.publicKey.toBase58(), s.env.creator.publicKey.toBase58()].sort());
  });

  it("MKT-09 / ORC-18 previous close is the official close; the reference update is the first at or after the previous close", async () => {
    const s = setup();
    await runMorning(s.deps, DATE);
    const inputs = await s.store.getStrikeInputs("META", DATE);
    expect(inputs!.prevCloseCents).toBe(68000n);
    const ref = await s.store.getOracleUpdate("META", DATE, "PREV_CLOSE");
    expect(ref!.targetTime).toBe(etToUnix(PREV, 16, 0));
    expect(ref!.publishTime).toBe(etToUnix(PREV, 16, 0) + 1);
    expect(ref!.priceRaw).toBe(68000n * 1000n + 7n);
  });

  it("MKT-03 rerun after a late confirmation creates nothing new", async () => {
    const s = setup();
    const target = marketPda("META", 20261125, 70000n);
    // The META 700 create lands, but the RPC times out before confirming it.
    s.env.faults.push({ kind: "TIMEOUT_AFTER_LANDING", match: (ixs) => ixs.some((ix) => ix.keys.some((k) => k.pubkey.equals(target))) });
    const first = await runMorning(s.deps, DATE);
    expect(first.status).toBe("OK"); // the ticker retried and found the market there
    const runs = (await s.store.jobRuns(DATE, "MORNING")).filter((r) => r.symbol === "META");
    expect(runs.map((r) => r.status)).toEqual(["RETRY", "OK"]);
    expect(runs[1]!.attempt).toBe(2);
    const sentBefore = s.env.sent.length;
    const rerun = await runMorning(s.deps, DATE);
    expect(rerun.tickers.every((t) => t.status === "OK" && t.created === 0)).toBe(true);
    expect(s.env.sent.length).toBe(sentBefore);
    expect(await s.deps.chain.markets(tickerDayPda("META", 20261125))).toHaveLength(9);
  });

  it("MKT-06 one ticker failing retries with backoff, pages at 08:45 and does not block the others", async () => {
    const s = setup();
    const tsla = tickerDayPda("TSLA", 20261125);
    // RPC fails for TSLA creates until 08:50.
    const until = etToUnix(DATE, 8, 50);
    for (let i = 0; i < 200; i++) {
      s.env.faults.push({ kind: "FAIL_BEFORE", match: (ixs) => s.clock.now() < until && ixs.some((ix) => ix.keys.some((k) => k.pubkey.equals(tsla))) });
    }
    const res = await runMorning(s.deps, DATE, { rand: () => 0.5 });
    s.env.faults = [];
    expect(res.tickers.find((t) => t.symbol === "TSLA")!.status).toBe("OK");
    expect(res.tickers.filter((t) => t.status === "OK")).toHaveLength(7);
    const pages = (await s.store.alerts()).filter((a) => a.severity === "PAGE");
    expect(pages.map((a) => [a.code, a.symbol])).toEqual([["MORNING_INCOMPLETE", "TSLA"]]);
    expect(pages[0]!.createdAt).toBeGreaterThanOrEqual(etToUnix(DATE, 8, 45));
    expect(s.clock.now()).toBeLessThan(etToUnix(DATE, 9, 0));
    const tslaRuns = (await s.store.jobRuns(DATE, "MORNING")).filter((r) => r.symbol === "TSLA");
    expect(tslaRuns.at(-1)!.status).toBe("OK");
    expect(tslaRuns.length).toBeGreaterThan(3);
    // Backoff grows: 5, 10, 20, 40, 60 (capped).
    expect(s.clock.sleeps.slice(0, 5)).toEqual([5, 10, 20, 40, 60]);
  });

  it("CAL-05 split day skips only that ticker, recorded as SKIPPED with a reason", async () => {
    const s = setup();
    s.store.corpActions.push({ symbol: "NVDA", effectiveDate: DATE, kind: "SPLIT", skipMarkets: true });
    const res = await runMorning(s.deps, DATE);
    expect(res.tickers.find((t) => t.symbol === "NVDA")).toMatchObject({ status: "SKIPPED" });
    expect(await s.deps.chain.tickerDay("NVDA", 20261125)).toBeNull();
    expect(await s.deps.chain.tickerDay("META", 20261125)).not.toBeNull();
    const nvda = (await s.store.jobRuns(DATE, "MORNING")).find((r) => r.symbol === "NVDA");
    expect(nvda).toMatchObject({ status: "SKIPPED" });
    expect(String(nvda!.detail?.reason)).toMatch(/SPLIT/);
    expect((await s.store.alerts()).every((a) => a.severity === "INFO")).toBe(true);
  });

  it("CAL-01 holiday: SKIPPED, no transaction, nothing above INFO", async () => {
    const s = setup(etToUnix("2026-11-26", 8, 0));
    const res = await runMorning(s.deps, "2026-11-26");
    expect(res.status).toBe("SKIPPED");
    expect(s.env.sent).toHaveLength(0);
    expect((await s.store.jobRuns("2026-11-26", "MORNING"))[0]).toMatchObject({ status: "SKIPPED" });
    expect(await s.store.alerts()).toEqual([]);
  });

  it("CAL-02 half-day: ticker-day close_time is 13:00 ET", async () => {
    const s = setup(etToUnix("2026-11-27", 8, 0));
    for (const sym of MAG7) {
      s.massive.set(sym, "2026-11-25", PREV_CLOSES[sym]!);
      s.databento.set(sym, "2026-11-25", PREV_CLOSES[sym]!);
    }
    await runMorning(s.deps, "2026-11-27");
    const td = await s.deps.chain.tickerDay("META", 20261127);
    expect(td!.closeTime).toBe(Date.parse("2026-11-27T18:00:00Z") / 1000);
  });

  it("MKT-10 yesterday's close missing: uses the latest stored official close with a WARN, else skips with a PAGE", async () => {
    const s = setup();
    s.massive.values.clear();
    s.databento.values.clear();
    // META has an older stored close (Monday); AAPL has none at all.
    await s.store.putOfficialClose({ symbol: "META", tradingDate: "2026-11-23", priceCents: 67500n, massiveCents: 67500n, massiveAt: 0, databentoCents: 67500n, databentoAt: 0 });
    s.store.tickers = s.store.tickers.filter((t) => t.symbol === "META" || t.symbol === "AAPL");
    const res = await runMorning(s.deps, DATE);
    expect(res.tickers.find((t) => t.symbol === "META")!.status).toBe("OK");
    expect((await s.store.getStrikeInputs("META", DATE))!.prevCloseCents).toBe(67500n);
    expect(res.tickers.find((t) => t.symbol === "AAPL")!.status).toBe("SKIPPED");
    const codes = (await s.store.alerts()).map((a) => `${a.severity} ${a.code} ${a.symbol}`);
    expect(codes).toContain("WARN PREV_CLOSE_STALE META");
    expect(codes).toContain("PAGE PREV_CLOSE_MISSING AAPL");
  });

  it("vendor disagreement on the previous close skips the ticker with a PAGE", async () => {
    const s = setup();
    s.databento.set("META", PREV, 68001n);
    const res = await runMorning(s.deps, DATE);
    expect(res.tickers.find((t) => t.symbol === "META")!.status).toBe("SKIPPED");
    expect((await s.store.alerts()).find((a) => a.code === "PREV_CLOSE_MISMATCH")?.symbol).toBe("META");
  });

  it("SEC-06 the market_creator key cannot run admin instructions", async () => {
    const s = setup();
    await runMorning(s.deps, DATE);
    // add_strike is admin-only; signed by the creator it fails Unauthorized.
    const { coder, metas, PROGRAM_ID } = await import("../src/chain/idl.js");
    const { TransactionInstruction } = await import("@solana/web3.js");
    const ixs = await s.deps.chain.ixsCreateMarket("META", 20261125, 69500n);
    const add = new TransactionInstruction({ programId: PROGRAM_ID, keys: ixs[0]!.keys, data: coder.instruction.encode("add_strike", { strike_cents: new (await import("bn.js")).default(69500) }) });
    await expect(s.env.send([add], [s.env.payer, s.env.creator])).rejects.toMatchObject({ errName: "Unauthorized" });
    void metas;
  });
});
