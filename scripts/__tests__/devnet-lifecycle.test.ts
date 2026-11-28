/**
 * MER-80: devnet deploy, lifecycle and release scripts, run against the local validator stand-in
 * (the real program in LiteSVM behind the scripts' Cluster interface).
 * Matrix: E2E-01, E2E-05, E2E-06, E2E-07, DLC-04, DLC-05, AGT-10.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { copyFileSync, appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROGRAM_ID } from "../../services/automation/src/chain/idl.js";
import { configPda, tickerDayPda } from "../../services/automation/src/chain/pdas.js";
import { buildCalendarYear, TradingCalendar } from "../../services/automation/src/calendar.js";
import { etToUnix } from "../../services/automation/src/time.js";
import { runCli } from "../devnet/cli.js";
import { deployDevnet, DeployError, DeploymentRecord, MAG7 } from "../devnet/deploy.js";
import { assertDevnet, GENESIS, MainnetRefused, refuseMainnetUrl } from "../devnet/guard.js";
import type { DevnetKeys } from "../devnet/keys.js";
import { expectedBalances, LifecycleOptions, redeemAll, runLifecycle, StepFailed } from "../devnet/lifecycle.js";
import { FileTickets, runRelease, Ticket, TicketSink } from "../devnet/release.js";
import { tokenAmount } from "../devnet/spl.js";
import { haveProgram, IDL_PATH, SO_PATH, SvmCluster } from "./helpers/svm-cluster.js";

// Built from parts so the repo's "no mainnet URL" doctor check stays meaningful.
const MAINNET_URL = `https://api.${"mainnet"}-beta.solana.com`;
const FEEDS = Object.fromEntries(MAG7.map((s, i) => [s, Buffer.alloc(32, i + 1).toString("hex")]));
const cal = new TradingCalendar(buildCalendarYear(2026));
const daySchedule = (iso: string) => ({ mintOpen: etToUnix(iso, 8, 30), open: cal.openTime(iso), close: cal.closeTime(iso) });

interface Env {
  cluster: SvmCluster;
  keys: DevnetKeys;
  record: DeploymentRecord;
}

async function setup(startIso = "2026-11-25"): Promise<Env> {
  const deployer = Keypair.generate();
  const cluster = new SvmCluster(etToUnix(startIso, 7, 0), deployer.publicKey);
  cluster.airdrop(deployer.publicKey, 100);
  const keys = { deployer, admin: Keypair.generate(), creator: Keypair.generate(), settler: Keypair.generate(), payer: Keypair.generate() };
  const record = await deployDevnet({
    cluster, keys, soPath: SO_PATH, idlPath: IDL_PATH, programKeypair: PROGRAM_ID, feeds: FEEDS, previous: null, commit: "abc1234",
    // Keep the spec's 20-minute dispute window here; the stand-in clock makes waiting free.
    settings: { disputeWindowS: 1_200, feeBps: 0 },
  });
  cluster.oracle.set(FEEDS.AAPL!, 68_512_000n); // $685.12
  cluster.oracle.set(FEEDS.MSFT!, 41_000_000n); // $410.00
  return { cluster, keys, record };
}

const lifecycle = (e: Env, o: Partial<LifecycleOptions> = {}) =>
  runLifecycle({
    cluster: e.cluster, keys: e.keys, deployment: e.record, ticker: "AAPL", date: 20261125, schedule: daySchedule("2026-11-25"),
    strikes: [68_000n, 69_000n], ...o,
  });

const usdcOf = async (e: Env, owner: PublicKey) => {
  const { ata } = await import("../../services/automation/src/chain/pdas.js");
  return tokenAmount((await e.cluster.getAccount(ata(owner, new PublicKey(e.record.usdcMint))))?.data);
};

const STEPS = [
  "preflight", "fund", "morning", "mint-and-quote", "buy-yes", "sell-yes", "buy-no", "sell-no", "halt-check",
  "record-close", "finalize", "settle", "prune-and-close", "redeem", "verify",
];

describe.skipIf(!haveProgram)("MER-80 devnet lifecycle on the local stand-in", () => {
  it("e2e_01_full_lifecycle_runs_every_step_in_order_and_balances_match_hand_calculation", async () => {
    const e = await setup();
    const { report, users, markets } = await lifecycle(e);

    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => s.step)).toEqual(STEPS);
    // Every step that sends a transaction reports its signatures (halt-check's trade is rejected;
    // preflight and verify only read).
    for (const s of report.steps.filter((x) => !["preflight", "halt-check", "verify"].includes(x.step))) {
      expect(s.signatures.length, s.step).toBeGreaterThan(0);
    }
    expect(report.steps.find((s) => s.step === "halt-check")!.detail).toEqual({ rejectedWith: "MarketHalted" });
    expect(report.outcomes).toEqual({ "68000": "YES", "69000": "NO" });

    // Hand calculation (YES at 685.12 >= 680): bob +$2, alice $0, carol -$2; USDC conserved.
    const exp = expectedBalances("YES");
    expect(exp).toEqual({ bob: 10_002_000_000n, alice: 1_000_000_000n, carol: 998_000_000n });
    expect(await usdcOf(e, users.bob.publicKey)).toBe(exp.bob);
    expect(await usdcOf(e, users.alice.publicKey)).toBe(exp.alice);
    expect(await usdcOf(e, users.carol.publicKey)).toBe(exp.carol);

    // Invariants after everyone redeemed: nothing accounted, vaults empty, books closed (D29).
    for (const m of markets) {
      const after = await new (await import("../../services/automation/src/chain/client.js")).MeridianChain(e.cluster, e.cluster, { payer: e.keys.payer }).market(m.address);
      expect(after!.collateralAccounted).toBe(0n);
      expect(tokenAmount((await e.cluster.getAccount(m.vault))?.data)).toBe(0n);
      expect(await e.cluster.getAccount(m.book)).toBeNull();
    }
  });

  it("e2e_01_hand_calculation_for_a_no_outcome", async () => {
    const e = await setup();
    e.cluster.oracle.set(FEEDS.AAPL!, 67_950_000n); // $679.50 < 680
    const { report } = await lifecycle(e);
    expect(report.outcomes!["68000"]).toBe("NO");
    expect(report.balances!.actual).toEqual(report.balances!.expected);
    expect(expectedBalances("NO")).toEqual({ bob: 10_007_000_000n, alice: 995_000_000n, carol: 998_000_000n });
  });

  it("e2e_05_half_day_halts_and_settles_on_the_13_00_close", async () => {
    const e = await setup("2026-11-27");
    expect(cal.row("2026-11-27").isHalfDay).toBe(true);
    const close = etToUnix("2026-11-27", 13, 0);
    const { report } = await lifecycle(e, { date: 20261127, schedule: daySchedule("2026-11-27") });
    expect(report.schedule.close).toBe(close);
    // The halt fired at 13:00 (the stand-in clock sat exactly on close_time) and the recorded
    // update is the one stamped at 13:00:00 ET.
    expect(report.closePrice!.publishTime).toBe(close);
    expect(report.steps.find((s) => s.step === "halt-check")!.ok).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("e2e_06_agt_10_runs_with_no_meridian_server_or_agent_reachable", async () => {
    const e = await setup();
    // API, WS, Tx Builder, Indexer and every agent are "down": any HTTP call fails the test.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => {
      throw new Error(`unexpected HTTP call to ${String(u)}`);
    });
    try {
      const { report } = await lifecycle(e);
      expect(report.ok).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("e2e_07_two_consecutive_days_are_independent_and_day_1_redeems_on_day_2", async () => {
    const e = await setup("2026-11-24");
    const day1 = await lifecycle(e, { date: 20261124, schedule: daySchedule("2026-11-24"), skipRedeem: ["alice"] });
    expect(day1.report.ok).toBe(true);
    const aliceBefore = await usdcOf(e, day1.users.alice.publicKey);

    const day2 = await lifecycle(e, { date: 20261125, schedule: daySchedule("2026-11-25"), users: { bob: day1.users.bob } });
    expect(day2.report.ok).toBe(true);
    expect(tickerDayPda("AAPL", 20261124).equals(tickerDayPda("AAPL", 20261125))).toBe(false);
    const d1 = new Set(day1.markets.map((m) => m.address.toBase58()));
    expect(day2.markets.some((m) => d1.has(m.address.toBase58()))).toBe(false);

    // alice kept 5 Yes of the day-1 680 strike (YES): redeeming it on day 2 pays $5.
    expect(await redeemAll(e.cluster, day1.users.alice, day1.markets[0]!, new PublicKey(e.record.usdcMint))).toBeTruthy();
    expect(await usdcOf(e, day1.users.alice.publicKey)).toBe(aliceBefore + 5_000_000n);
  });

  it("a failing step stops the run and names that step", async () => {
    const e = await setup();
    e.cluster.breakInstruction = "redeem";
    const err = await lifecycle(e).catch((x) => x);
    expect(err).toBeInstanceOf(StepFailed);
    expect((err as StepFailed).step).toBe("redeem");
    expect((err as StepFailed).message).toContain("step 'redeem'");
    const r = (err as StepFailed).report;
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe("redeem");
    expect(r.steps.at(-1)).toMatchObject({ step: "redeem", ok: false });
  });

  it("refuses to settle on a Pyth update outside the program's window", async () => {
    const e = await setup();
    e.cluster.oracle.lagS = 30; // first update 30 s after close; the program allows 5 s
    const err = await lifecycle(e).catch((x) => x);
    expect((err as StepFailed).step).toBe("record-close");
    expect((err as StepFailed).message).toMatch(/30s after close_time; the program allows 5s/);
  });

  it("deploy is idempotent and records program id and IDL hash", async () => {
    const e = await setup();
    expect(e.record.programId).toBe(PROGRAM_ID.toBase58());
    expect(e.record.idlSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(e.record.soSha256).toMatch(/^[0-9a-f]{64}$/);
    const cfgBefore = Buffer.from((await e.cluster.getAccount(configPda()))!.data);
    const again = await deployDevnet({
      cluster: e.cluster, keys: e.keys, soPath: SO_PATH, idlPath: IDL_PATH, programKeypair: PROGRAM_ID, feeds: FEEDS,
      previous: e.record, commit: "def5678", settings: { disputeWindowS: 1_200, feeBps: 0 },
    });
    expect(again.usdcMint).toBe(e.record.usdcMint);
    expect(again.feeVault).toBe(e.record.feeVault);
    expect(Buffer.from((await e.cluster.getAccount(configPda()))!.data).equals(cfgBefore)).toBe(true);
    expect(e.cluster.deployments).toHaveLength(2);
  });

  it("deploy refuses a program keypair that is not the declared program id", async () => {
    const e = await setup();
    await expect(deployDevnet({
      cluster: e.cluster, keys: e.keys, soPath: SO_PATH, idlPath: IDL_PATH, programKeypair: Keypair.generate().publicKey, feeds: FEEDS,
      previous: e.record, commit: "x",
    })).rejects.toThrow(DeployError);
  });
});

describe("devnet guard (DLC-04)", () => {
  it("refuses mainnet URLs before any network call", () => {
    for (const u of [MAINNET_URL, "https://solana-mainnet.example-rpc.com/abc", "https://rpc.example.com/mainnet/v1", "not a url"]) {
      expect(() => refuseMainnetUrl(u), u).toThrow(MainnetRefused);
    }
    expect(() => refuseMainnetUrl("https://api.devnet.solana.com")).not.toThrow();
  });

  it("checks the genesis hash: mainnet and testnet refused, devnet ok, unknown only on loopback", async () => {
    const g = (h: string) => async () => h;
    await expect(assertDevnet("https://rpc.example.com", g(GENESIS.mainnet))).rejects.toThrow(/serves mainnet/);
    await expect(assertDevnet("https://rpc.example.com", g(GENESIS.testnet))).rejects.toThrow(/testnet/);
    await expect(assertDevnet("https://rpc.example.com", g(GENESIS.devnet))).resolves.toBe("devnet");
    await expect(assertDevnet("http://127.0.0.1:8899", g("LocalGenesis111"))).resolves.toBe("local");
    await expect(assertDevnet("https://rpc.example.com", g("LocalGenesis111"))).rejects.toThrow(/unknown cluster/);
  });

  it("the CLI exits non-zero on a mainnet URL without generating keys or deploying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-cli-"));
    const saved = { ...process.env };
    process.env.DEVNET_RPC_URL = MAINNET_URL;
    process.env.DEVNET_DIR = dir;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runCli(["deploy"])).toBe(1);
      expect(await runCli(["release"])).toBe(1);
      expect(err.mock.calls.flat().join("\n")).toMatch(/devnet only \(DLC-04\)/);
      expect(() => readFileSync(join(dir, "keys/admin.json"))).toThrow();
      expect(await runCli(["bogus"])).toBe(2);
    } finally {
      process.env = saved;
      err.mockRestore();
    }
  });
});

class MemoryTickets implements TicketSink {
  readonly opened: Ticket[] = [];
  async open(t: Ticket) {
    this.opened.push(t);
    return `ticket-${this.opened.length}`;
  }
}

describe.skipIf(!haveProgram)("release smoke (DLC-04, DLC-05)", () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "meridian-release-"));
  });
  afterEach(() => vi.restoreAllMocks());

  const release = (e: Env, soPath: string, tickets: TicketSink) =>
    runRelease({
      cluster: e.cluster, tickets, workDir: work,
      deploy: { keys: e.keys, soPath, idlPath: IDL_PATH, programKeypair: PROGRAM_ID, feeds: FEEDS, previous: e.record, commit: "feedbeef", settings: { disputeWindowS: 1_200, feeBps: 0 } },
      lifecycle: { ticker: "AAPL", date: 20261125, schedule: daySchedule("2026-11-25"), strikes: [68_000n] },
    });

  it("dlc_05_smoke_failure_at_redeem_rolls_back_to_the_previous_program_and_opens_a_bug_ticket", async () => {
    const e = await setup();
    // The "new" binary differs from the live one (trailing bytes), and its redeem is broken.
    const next = join(work, "next.so");
    copyFileSync(SO_PATH, next);
    appendFileSync(next, Buffer.alloc(16, 0xab));
    e.cluster.breakInstruction = "redeem";
    const tickets = new MemoryTickets();

    const r = await release(e, next, tickets);

    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe("redeem");
    expect(r.rolledBack).toBe(true);
    const [first, deployedNext, rollback] = e.cluster.deployments;
    expect(e.cluster.deployments).toHaveLength(3);
    expect(deployedNext!.equals(readFileSync(next))).toBe(true);
    expect(rollback!.equals(first!)).toBe(true);
    expect(r.liveSoSha256).not.toBe(r.soSha256);
    expect(tickets.opened).toHaveLength(1);
    expect(tickets.opened[0]!.title).toMatch(/failed at redeem \(feedbee\)/);
    expect(tickets.opened[0]!.body).toContain("Rolled back: yes");
    expect(tickets.opened[0]!.labels).toEqual(["bug", "release-smoke"]);
    expect(r.ticket).toBe("ticket-1");
  });

  it("a green smoke keeps the new program and reports commit, program id and IDL hash", async () => {
    const e = await setup();
    const tickets = new MemoryTickets();
    const r = await release(e, SO_PATH, tickets);
    expect(r.ok).toBe(true);
    expect(r.rolledBack).toBe(false);
    expect(tickets.opened).toHaveLength(0);
    expect(r).toMatchObject({ commit: "feedbeef", programId: PROGRAM_ID.toBase58(), idlSha256: e.record.idlSha256 });
    expect(r.lifecycle!.ok).toBe(true);
  });

  it("dlc_04_release_against_mainnet_is_refused_before_dump_or_deploy", async () => {
    const e = await setup();
    const before = e.cluster.deployments.length;
    e.cluster.assertSafe = () => assertDevnet(MAINNET_URL, async () => GENESIS.mainnet).then(() => {});
    const dump = vi.spyOn(e.cluster, "dump");
    const tickets = new FileTickets(join(work, "tickets"));
    await expect(release(e, SO_PATH, tickets)).rejects.toThrow(MainnetRefused);
    expect(dump).not.toHaveBeenCalled();
    expect(e.cluster.deployments).toHaveLength(before);
  });
});
