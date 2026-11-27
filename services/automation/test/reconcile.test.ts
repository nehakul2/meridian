// MER-47: nightly reconcile (IDX-09).
import { describe, expect, it } from "vitest";
import { runReconcile, type Backfiller, type ChainHistory, type ChainSig } from "../src/jobs/reconcile.js";
import { runMorning } from "../src/jobs/morning.js";
import { marketPda } from "../src/chain/pdas.js";
import type { FillRow } from "../src/store/types.js";
import { etToUnix } from "../src/time.js";
import { FakeClock, makeDeps } from "./helpers/fakes.js";
import { haveProgram, SvmEnv } from "./helpers/svm.js";

const DATE = "2026-11-25";
const T = etToUnix(DATE, 11, 0);

function fixture() {
  const sigs: ChainSig[] = [
    { signature: "sigA", slot: 1, blockTime: T },
    { signature: "sigB", slot: 2, blockTime: T + 60 },
  ];
  const fills: Record<string, FillRow[]> = {
    sigA: [{ signature: "sigA", eventIndex: 1, marketPda: "M680", seq: 5n, qty: 10n, priceCents: 61, blockTime: T }],
    sigB: [{ signature: "sigB", eventIndex: 0, marketPda: "M680", seq: 6n, qty: 3n, priceCents: 62, blockTime: T + 60 }],
  };
  const history: ChainHistory = { signatures: async () => sigs, fills: async (s) => fills[s.signature] ?? [] };
  return { sigs, fills, history };
}

async function setup() {
  const clock = new FakeClock(etToUnix(DATE, 8, 0));
  const env = new SvmEnv(clock);
  const ctx = makeDeps({ clock, chain: env.chain() });
  ctx.store.tickers = ctx.store.tickers.filter((t) => t.symbol === "META");
  ctx.massive.set("META", "2026-11-24", 68000n);
  ctx.databento.set("META", "2026-11-24", 68000n);
  await runMorning(ctx.deps, DATE);
  clock.t = etToUnix(DATE, 20, 0);
  return { clock, env, ...ctx };
}

/** PG Writer stand-in: inserts each missing signature's rows once. */
class FakeBackfill implements Backfiller {
  calls: string[][] = [];
  constructor(private readonly s: Awaited<ReturnType<typeof setup>>, private readonly f: ReturnType<typeof fixture>) {}
  async backfill(signatures: string[]) {
    this.calls.push(signatures);
    let n = 0;
    for (const sig of signatures) {
      const known = this.s.store.signatures.get(DATE) ?? new Set<string>();
      for (const f of this.f.fills[sig] ?? []) {
        const i = this.s.store.fillRows.findIndex((x) => x.signature === f.signature && x.eventIndex === f.eventIndex);
        if (i >= 0 && this.s.store.fillRows[i]!.qty === f.qty && this.s.store.fillRows[i]!.priceCents === f.priceCents) continue;
        if (i >= 0) this.s.store.fillRows.splice(i, 1);
        this.s.store.fillRows.push({ ...f, symbol: "META" });
        n++;
      }
      known.add(sig);
      this.s.store.signatures.set(DATE, known);
    }
    return n;
  }
}

function seedPg(s: Awaited<ReturnType<typeof setup>>, f: ReturnType<typeof fixture>) {
  s.store.signatures.set(DATE, new Set(f.sigs.map((x) => x.signature)));
  for (const list of Object.values(f.fills)) for (const r of list) s.store.fillRows.push({ ...r, symbol: "META" });
}

describe.skipIf(!haveProgram)("reconcile", () => {
  it("a clean day produces an empty diff and no alerts", async () => {
    const s = await setup();
    const f = fixture();
    seedPg(s, f);
    const r = await runReconcile(s.deps, f.history, DATE);
    expect(r).toEqual({ missingSignatures: [], missingFills: [], mismatchedFills: [], invariantBreaks: [], backfilled: 0 });
    expect(s.store.reports).toHaveLength(1);
    expect(await s.store.alerts()).toEqual([]);
    expect((await s.store.jobRuns(DATE, "RECONCILE"))[0]!.status).toBe("OK");
  });

  it("IDX-09 a corrupted fills row is detected, alerted and restored by backfill once", async () => {
    const s = await setup();
    const f = fixture();
    seedPg(s, f);
    s.store.fillRows.find((x) => x.signature === "sigB")!.qty = 300n; // corrupt
    const bf = new FakeBackfill(s, f);
    const r = await runReconcile(s.deps, f.history, DATE, { backfiller: bf });
    expect(r.mismatchedFills).toEqual(["sigB:0"]);
    expect(r.backfilled).toBe(1);
    expect(s.store.fillRows.find((x) => x.signature === "sigB")!.qty).toBe(3n);
    expect((await s.store.alerts()).map((a) => `${a.severity} ${a.code}`)).toEqual(["WARN RECONCILE_DIFF"]);
    // Rerunning backfill inserts nothing new; the next reconcile is clean.
    expect(await bf.backfill(["sigB"])).toBe(0);
    const again = await runReconcile(s.deps, f.history, DATE, { backfiller: bf });
    expect(again.mismatchedFills).toEqual([]);
    expect(again.backfilled).toBe(0);
  });

  it("a missing signature and its fill are detected and backfilled", async () => {
    const s = await setup();
    const f = fixture();
    s.store.signatures.set(DATE, new Set(["sigA"]));
    s.store.fillRows.push({ ...f.fills.sigA![0]!, symbol: "META" });
    const bf = new FakeBackfill(s, f);
    const r = await runReconcile(s.deps, f.history, DATE, { backfiller: bf });
    expect(r.missingSignatures).toEqual(["sigB"]);
    expect(r.missingFills).toEqual(["sigB:0"]);
    expect(bf.calls).toEqual([["sigB"]]);
    expect(s.store.reports.at(-1)!.missingCount).toBe(2);
  });

  it("an invariant break on chain state raises a PAGE", async () => {
    const s = await setup();
    const f = fixture();
    seedPg(s, f);
    // Corrupt the Yes mint supply of META 680 (fixture tampering, as the case asks).
    const m = (await s.deps.chain.market(marketPda("META", 20261125, 68000n)))!;
    const acct = s.env.svm.getAccount(m.yesMint)!;
    const data = Buffer.from(acct.data);
    data.writeBigUInt64LE(7n, 36);
    s.env.svm.setAccount(m.yesMint, { ...acct, data });
    const r = await runReconcile(s.deps, f.history, DATE);
    expect(r.invariantBreaks).toHaveLength(1);
    expect(r.invariantBreaks[0]).toMatch(/META 68000: Yes 7 \/ No 0 \/ pairs 0/);
    const page = (await s.store.alerts()).find((a) => a.code === "INVARIANT_BREAK")!;
    expect(page.severity).toBe("PAGE");
  });
});
