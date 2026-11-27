// MER-44: settler job against the real program on LiteSVM.
import { Connection, Keypair, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { describe, expect, it } from "vitest";
import { RpcSender } from "../src/chain/client.js";
import { coder, metas, PROGRAM_ID } from "../src/chain/idl.js";
import { configPda, eventAuthority, tickerDayPda } from "../src/chain/pdas.js";
import { runMorning } from "../src/jobs/morning.js";
import { runSettle } from "../src/jobs/settler.js";
import { etToUnix } from "../src/time.js";
import { FakeClock, makeDeps } from "./helpers/fakes.js";
import { haveProgram, MAG7, SvmEnv } from "./helpers/svm.js";

const DATE = "2026-11-25";
const CLOSE = etToUnix(DATE, 16, 0);
const PRICE: Record<string, bigint> = { AAPL: 23012n, MSFT: 41544n, GOOGL: 17533n, AMZN: 20577n, NVDA: 19011n, META: 68512n, TSLA: 25099n };

async function setup(symbols = MAG7, date = DATE) {
  const close = etToUnix(date, date === "2026-11-27" ? 13 : 16, 0);
  const clock = new FakeClock(etToUnix(date, 8, 0));
  const env = new SvmEnv(clock);
  const ctx = makeDeps({ clock, chain: env.chain(), poster: env });
  ctx.store.tickers = ctx.store.tickers.filter((t) => symbols.includes(t.symbol));
  const prev = ctx.deps.calendar.previousTradingDay(date);
  for (const s of symbols) {
    ctx.massive.set(s, prev, PRICE[s]!);
    ctx.databento.set(s, prev, PRICE[s]!);
  }
  await runMorning(ctx.deps, date);
  ctx.hermes.calls.length = 0;
  clock.t = close + 300;
  return { clock, env, close, ...ctx };
}

/** Both vendors publish `cents`; Pyth has an update at close + 1 s with conf `confBps`. */
function happy(s: Awaited<ReturnType<typeof setup>>, sym: string, cents = PRICE[sym]!, confBps = 1n) {
  s.massive.set(sym, DATE, cents);
  s.databento.set(sym, DATE, cents);
  const price = cents * 1000n;
  s.hermes.add(sym, { price, conf: (price * confBps) / 10_000n, publishTime: s.close + 1 });
}

describe.skipIf(!haveProgram)("settler", () => {
  it("SJ-01 happy path: all 7 tickers PROVISIONAL within 10 min of the close", async () => {
    const s = await setup();
    for (const sym of MAG7) happy(s, sym);
    const out = await runSettle(s.deps, DATE);
    expect(out.map((o) => o.status)).toEqual(MAG7.map(() => "RECORDED"));
    for (const sym of MAG7) {
      const td = await s.deps.chain.tickerDay(sym, 20261125);
      expect(td!.status).toBe("Provisional");
      expect(td!.price).toBe(PRICE[sym]! * 1000n);
      expect(td!.closeSource).toBe("AttestedChecked");
    }
    expect(s.clock.now()).toBeLessThanOrEqual(CLOSE + 600);
    expect((await s.store.jobRuns(DATE, "SETTLE")).every((r) => r.status === "OK")).toBe(true);
    expect(await s.store.alerts()).toEqual([]);
  });

  it("SJ-02 retries resubmit the identical stored update; Hermes is not asked again", async () => {
    const s = await setup(["META"]);
    happy(s, "META", PRICE.META!, 20n); // conf 20 bps > 10 bps cap: record_close rejects
    s.hermes.add("META", { price: 68600000n, conf: 1000n, publishTime: CLOSE + 2 }); // a newer, valid tick
    const [o] = await runSettle(s.deps, DATE, { rand: () => 0.5 });
    expect(o!.status).toBe("FAILED");
    expect(s.env.posted.length).toBeGreaterThan(5);
    for (const p of s.env.posted) expect(Buffer.from(p).equals(Buffer.from(s.env.posted[0]!))).toBe(true);
    expect(s.hermes.calls).toHaveLength(1);
    const stored = await s.store.getOracleUpdate("META", DATE, "SETTLE");
    expect(Buffer.from(stored!.vaa).equals(Buffer.from(s.env.posted[0]!))).toBe(true);
    expect(stored!.publishTime).toBe(CLOSE + 1);
  });

  it("SJ-03 re-queries the same close timestamp until an update exists; an out-of-window one is never stored", async () => {
    const s = await setup(["META"]);
    s.massive.set("META", DATE, PRICE.META!);
    s.databento.set("META", DATE, PRICE.META!);
    // Nothing at or after 16:00 until 16:00:40, and that update is beyond ε = 5 s.
    s.hermes.add("META", { price: 68512000n, conf: 1000n, publishTime: CLOSE + 40, visibleAt: CLOSE + 40 });
    const [o] = await runSettle(s.deps, DATE, { rand: () => 0.5 });
    expect(o!.status).toBe("FAILED");
    expect(new Set(s.hermes.calls.map((c) => c.target))).toEqual(new Set([CLOSE]));
    expect(await s.store.getOracleUpdate("META", DATE, "SETTLE")).toBeNull();
    expect(s.env.posted).toHaveLength(0);

    // Same, but an in-window update (16:00:03) becomes visible at 16:07: recorded then.
    const t = await setup(["META"]);
    t.massive.set("META", DATE, PRICE.META!);
    t.databento.set("META", DATE, PRICE.META!);
    t.hermes.add("META", { price: 68512000n, conf: 1000n, publishTime: CLOSE + 3, visibleAt: CLOSE + 420 });
    const [p] = await runSettle(t.deps, DATE, { rand: () => 0.5 });
    expect(p!.status).toBe("RECORDED");
    expect(t.clock.now()).toBeGreaterThanOrEqual(CLOSE + 420);
    expect((await t.store.getOracleUpdate("META", DATE, "SETTLE"))!.publishTime).toBe(CLOSE + 3);
  });

  it("SJ-04 / SJ-05 retries every 30 s to close + 15 min, WARN at +5 and PAGE at +15", async () => {
    const s = await setup(["META"]);
    happy(s, "META", PRICE.META!, 50n); // always rejected (conf too wide)
    const [o] = await runSettle(s.deps, DATE, { rand: () => 0.5 });
    expect(o!.status).toBe("FAILED");
    expect(o!.attempts).toBe(21); // 16:05:00 .. 16:15:00 every 30 s
    expect(s.clock.sleeps.every((x) => x === 30)).toBe(true);
    const runs = await s.store.jobRuns(DATE, "SETTLE");
    expect(runs.at(-1)!.status).toBe("FAILED");
    expect(runs.slice(0, -1).every((r) => r.status === "RETRY")).toBe(true);
    const alerts = await s.store.alerts();
    expect(alerts.map((a) => `${a.severity} ${a.code}`)).toEqual(["WARN SETTLE_SLA_AT_RISK", "PAGE SETTLE_FAILED"]);
    expect(alerts[0]!.createdAt).toBe(CLOSE + 300);
    expect(alerts[1]!.createdAt).toBe(CLOSE + 900);
    expect(alerts[1]!.message).toMatch(/Admin override needed/);
    expect(alerts[1]!.message).toMatch(/ConfidenceTooWide/);
  });

  it("SJ-04 jitter stays within ±3 s", async () => {
    const s = await setup(["META"]);
    happy(s, "META", PRICE.META!, 50n);
    let i = 0;
    await runSettle(s.deps, DATE, { rand: () => [0, 1, 0.25][i++ % 3]! });
    expect(s.clock.sleeps.every((x) => x >= 27 && x <= 33)).toBe(true);
    expect(new Set(s.clock.sleeps).size).toBeGreaterThan(1);
  });

  it("SJ-06 tickers settle independently: TSLA failing does not hold up the others", async () => {
    const s = await setup();
    for (const sym of MAG7) if (sym !== "TSLA") happy(s, sym);
    s.massive.set("TSLA", DATE, PRICE.TSLA!);
    s.databento.set("TSLA", DATE, PRICE.TSLA!); // but no Pyth update ever
    const out = await runSettle(s.deps, DATE, { rand: () => 0.5 });
    expect(out.filter((o) => o.status === "RECORDED")).toHaveLength(6);
    expect(out.find((o) => o.symbol === "TSLA")!.status).toBe("FAILED");
    const firstAttempts = (await s.store.jobRuns(DATE, "SETTLE")).filter((r) => r.symbol !== "TSLA");
    expect(firstAttempts.every((r) => r.attempt === 1 && r.finishedAt! <= CLOSE + 300)).toBe(true);
    expect((await s.store.alerts()).filter((a) => a.severity === "PAGE").map((a) => a.symbol)).toEqual(["TSLA"]);
  });

  it("SJ-09 restart mid-run: recorded tickers are skipped, the rest use their stored updates", async () => {
    const s = await setup(["META", "AAPL"]);
    happy(s, "META");
    happy(s, "AAPL");
    // First run: AAPL's poster fails once after META recorded (process dies).
    s.store.tickers = s.store.tickers.filter((t) => t.symbol === "META");
    await runSettle(s.deps, DATE);
    s.store.tickers = [...(await import("./helpers/fakes.js")).mag7Store(s.clock).tickers.filter((t) => ["META", "AAPL"].includes(t.symbol))];
    const posted = s.env.posted.length;
    const out = await runSettle(s.deps, DATE);
    expect(out.find((o) => o.symbol === "META")!.status).toBe("ALREADY_RECORDED");
    expect(out.find((o) => o.symbol === "AAPL")!.status).toBe("RECORDED");
    expect(s.env.posted.length).toBe(posted + 1);
  });

  it("CON-07 two settler instances: one record per ticker, the other logs success", async () => {
    const s = await setup(["META"]);
    happy(s, "META");
    const [a, b] = await Promise.all([runSettle(s.deps, DATE), runSettle(s.deps, DATE)]);
    const statuses = [a![0]!.status, b![0]!.status].sort();
    expect(statuses).toEqual(["ALREADY_RECORDED", "RECORDED"]);
    expect((await s.store.jobRuns(DATE, "SETTLE")).every((r) => r.status === "OK")).toBe(true);
  });

  it("SJ-10 Massive and Databento must match; never write from one vendor", async () => {
    // Case A: 685.12 vs 685.10.
    const s = await setup(["META"]);
    s.massive.set("META", DATE, 68512n);
    s.databento.set("META", DATE, 68510n);
    s.hermes.add("META", { price: 68512000n, conf: 1000n, publishTime: CLOSE + 1 });
    const [a] = await runSettle(s.deps, DATE);
    expect(a!.status).toBe("ESCALATED");
    expect(s.env.posted).toHaveLength(0);
    const page = (await s.store.alerts()).find((x) => x.code === "SETTLE_VENDOR_MISMATCH")!;
    expect(page.severity).toBe("PAGE");
    expect(page.message).toMatch(/\$685\.12.*\$685\.10/);
    expect(await s.store.getOfficialClose("META", DATE)).toBeNull();

    // Case B: Databento has nothing until close + 15 min.
    const t = await setup(["META"]);
    t.massive.set("META", DATE, 68512n);
    t.databento.set("META", DATE, 68512n, CLOSE + 901);
    t.hermes.add("META", { price: 68512000n, conf: 1000n, publishTime: CLOSE + 1 });
    const [b] = await runSettle(t.deps, DATE, { rand: () => 0.5 });
    expect(b!.status).toBe("FAILED");
    expect(t.env.posted).toHaveLength(0);
    expect((await t.store.alerts()).find((x) => x.code === "SETTLE_FAILED")!.message).toMatch(/Databento/);
    expect((await t.deps.chain.tickerDay("META", 20261125))!.status).toBe("Open"); // admin path at close + 30 min

    // Equal values record normally.
    const u = await setup(["META"]);
    happy(u, "META");
    expect((await runSettle(u.deps, DATE))[0]!.status).toBe("RECORDED");
  });

  it("ORC-17 no record before the official close exists; never the last trade or a later tick", async () => {
    const s = await setup(["META"]);
    s.massive.set("META", DATE, 68512n, CLOSE + 420);
    s.databento.set("META", DATE, 68512n, CLOSE + 420);
    s.hermes.add("META", { price: 68512000n, conf: 1000n, publishTime: CLOSE + 1 });
    s.hermes.add("META", { price: 68700000n, conf: 1000n, publishTime: CLOSE + 4 });
    const [o] = await runSettle(s.deps, DATE, { rand: () => 0.5 });
    expect(o!.status).toBe("RECORDED");
    expect(s.env.posted).toHaveLength(1);
    expect(s.clock.now()).toBeGreaterThanOrEqual(CLOSE + 420);
    const td = await s.deps.chain.tickerDay("META", 20261125);
    expect(td!.price).toBe(68512000n);
    expect((await s.store.getOracleUpdate("META", DATE, "SETTLE"))!.publishTime).toBe(CLOSE + 1);
  });

  it("an official close outside the Pyth tolerance escalates at once and records nothing", async () => {
    const s = await setup(["META"]);
    s.massive.set("META", DATE, 69000n);
    s.databento.set("META", DATE, 69000n);
    s.hermes.add("META", { price: 68512000n, conf: 1000n, publishTime: CLOSE + 1 });
    const [o] = await runSettle(s.deps, DATE);
    expect(o!.status).toBe("ESCALATED");
    expect((await s.store.alerts()).map((a) => a.code)).toContain("SETTLE_CROSS_CHECK_FAILED");
    expect((await s.deps.chain.tickerDay("META", 20261125))!.status).toBe("Open");
  });

  it("CAL-02 half-day: the settler targets 13:00 ET, not 16:00", async () => {
    const s = await setup(["META"], "2026-11-27");
    const close = etToUnix("2026-11-27", 13, 0);
    s.massive.set("META", "2026-11-27", 68512n);
    s.databento.set("META", "2026-11-27", 68512n);
    s.hermes.add("META", { price: 68512000n, conf: 1000n, publishTime: close + 1 });
    const [o] = await runSettle(s.deps, "2026-11-27");
    expect(o!.status).toBe("RECORDED");
    expect(s.hermes.calls[0]!.target).toBe(close);
    expect(s.hermes.calls[0]!.t).toBe(close + 300);
  });

  it("SEC-06 the settler key cannot run admin instructions", async () => {
    const s = await setup(["META"]);
    const td = tickerDayPda("META", 20261125);
    s.clock.t = CLOSE + 1800;
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: metas("admin_settle", { admin: s.env.settler.publicKey, config: configPda(), ticker_day: td, event_authority: eventAuthority() }),
      data: coder.instruction.encode("admin_settle", { price: new BN(68512000), expo: -5 }),
    });
    await expect(s.env.send([ix], [s.env.settler])).rejects.toMatchObject({ errName: "Unauthorized" });
    const pause = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: metas("pause", { admin: s.env.settler.publicKey, config: configPda(), event_authority: eventAuthority() }),
      data: coder.instruction.encode("pause", {}),
    });
    await expect(s.env.send([pause], [s.env.settler])).rejects.toMatchObject({ errName: "Unauthorized" });
    void SystemProgram;
  });
});

describe("RPC sender", () => {
  it("SJ-08 blockhash expiry: rebuilt with a fresh blockhash and a raised priority fee", async () => {
    const blockhashes: string[] = [];
    const fees: number[] = [];
    let sends = 0;
    const conn = {
      getLatestBlockhash: async () => {
        const bh = Keypair.generate().publicKey.toBase58();
        blockhashes.push(bh);
        return { blockhash: bh, lastValidBlockHeight: 100 };
      },
      sendRawTransaction: async (raw: Uint8Array) => {
        const { VersionedTransaction, ComputeBudgetProgram } = await import("@solana/web3.js");
        const tx = VersionedTransaction.deserialize(raw);
        const keys = tx.message.staticAccountKeys;
        const priceIx = tx.message.compiledInstructions.find((ix) => keys[ix.programIdIndex]!.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3);
        fees.push(priceIx ? Number(Buffer.from(priceIx.data).readBigUInt64LE(1)) : 0);
        sends++;
        if (sends === 1) throw new Error("Transaction simulation failed: Blockhash not found");
        return "sig2";
      },
      confirmTransaction: async () => ({ value: { err: null } }),
    } as unknown as Connection;
    const payer = Keypair.generate();
    const sig = await new RpcSender(conn).send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 })], [payer], { priorityMicroLamports: 5_000 });
    expect(sig).toBe("sig2");
    expect(new Set(blockhashes).size).toBe(2);
    expect(fees).toEqual([5_000, 10_000]);
  });

  it("maps a custom program error from a failed confirmation", async () => {
    const conn = {
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
      sendRawTransaction: async () => "s",
      confirmTransaction: async () => ({ value: { err: { InstructionError: [0, { Custom: 6044 }] } } }),
    } as unknown as Connection;
    const payer = Keypair.generate();
    await expect(new RpcSender(conn).send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 })], [payer]))
      .rejects.toMatchObject({ code: 6044, errName: "ConfidenceStraddle" });
  });
});
