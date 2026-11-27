// MER-49: strike inputs (implied volatility, realized vol, liquidity tier) and the Massive parsers.
import { describe, expect, it } from "vitest";
import { silentLogger } from "../src/alerts.js";
import { freezeStrikeInputs, realizedVolBps } from "../src/strikeInputs.js";
import { MemoryStore } from "../src/store/memory.js";
import { etToUnix, IsoDate } from "../src/time.js";
import { fractionToBps, MassiveClient, pickAtmIv } from "../src/vendors/massive.js";
import { DatabentoClient } from "../src/vendors/databento.js";
import { toCents } from "../src/vendors/http.js";
import { calendar2026, FakeIv } from "./helpers/fakes.js";

const DATE = "2026-11-25";
const cal = calendar2026();

function deps(store: MemoryStore, iv: FakeIv | null) {
  return { store, iv, calendar: cal, log: silentLogger, now: () => etToUnix(DATE, 8, 0) };
}

/** 21 official closes before DATE, alternating ±1% around 100.00. */
async function seedCloses(store: MemoryStore, symbol: string, n = 21) {
  let d: IsoDate = DATE;
  const days: IsoDate[] = [];
  for (let i = 0; i < n; i++) days.push((d = cal.previousTradingDay(d)));
  days.reverse().forEach((day, i) => {
    const c = i % 2 === 0 ? 10000n : 10100n;
    void store.putOfficialClose({ symbol, tradingDate: day, priceCents: c, massiveCents: c, massiveAt: 0, databentoCents: c, databentoAt: 0 });
  });
}

function addFills(store: MemoryStore, symbol: string, perDay: bigint, days: number) {
  let d: IsoDate = DATE;
  for (let i = 0; i < days; i++) {
    d = cal.previousTradingDay(d);
    store.fillRows.push({ symbol, signature: `s${i}`, eventIndex: 0, marketPda: "m", seq: 1n, qty: perDay, priceCents: 50, blockTime: etToUnix(d, 12, 0) });
  }
}

describe("strike inputs", () => {
  it("STK-10 IV present is used; IV missing falls back to RV20 x 1.2 with the basis recorded", async () => {
    const store = new MemoryStore();
    await seedCloses(store, "META");
    const iv = new FakeIv();
    iv.values.set("META", 3500n);
    const a = await freezeStrikeInputs(deps(store, iv), "META", DATE, 68000n, null);
    expect([a.row.volBasis, a.row.ivBps, a.row.volUsedBps]).toEqual(["IV", 3500n, 3500n]);
    expect(a.row.ivSource).toMatch(/^MASSIVE/);

    const b = await freezeStrikeInputs(deps(store, new FakeIv()), "AAPL", DATE, 23000n, null);
    expect(b.row.volBasis).toBe("RV_FALLBACK");
    expect(b.row.ivBps).toBeNull();
    // No AAPL closes stored: RV20 = 0, so vol is the 15% floor.
    expect(b.row.volUsedBps).toBe(1500n);
  });

  it("RV20 computed from fixture closes (alternating +1% / -0.99%)", () => {
    // 20 returns alternating +1% and -0.990099%: deviations ±0.0099505 from the mean, sample sd
    // = 0.0099505 × sqrt(20/19) = 0.0102089; × sqrt(252) = 16.206% → 1621 bps.
    const closes = Array.from({ length: 21 }, (_, i) => (i % 2 === 0 ? 10000n : 10100n));
    expect(realizedVolBps(closes)).toBe(1621n);
    expect(realizedVolBps([10000n, 10000n, 10000n])).toBe(0n);
    expect(realizedVolBps([10000n, 10100n])).toBeNull();
  });

  it("liquidity tier thresholds at the boundaries; override wins; no history is tier B", async () => {
    const at = async (perDay: bigint | null, override: "A" | "B" | "C" | null = null) => {
      const store = new MemoryStore();
      if (perDay !== null) addFills(store, "TSLA", perDay, 5);
      return (await freezeStrikeInputs(deps(store, null), "TSLA", DATE, 25000n, override)).row;
    };
    expect((await at(50_000n)).liquidityTier).toBe("A");
    expect((await at(49_999n)).liquidityTier).toBe("B");
    expect((await at(5_000n)).liquidityTier).toBe("B");
    expect((await at(4_999n)).liquidityTier).toBe("C");
    expect((await at(null)).liquidityTier).toBe("B");
    expect((await at(4_999n, "A")).liquidityTier).toBe("A");
    expect((await at(60_000n)).liquidityContracts5d).toBe(60_000n);
  });

  it("the inputs row is written once and reused on rerun", async () => {
    const store = new MemoryStore();
    const iv = new FakeIv();
    iv.values.set("META", 3500n);
    const a = await freezeStrikeInputs(deps(store, iv), "META", DATE, 68000n, "A");
    iv.values.set("META", 9000n);
    const b = await freezeStrikeInputs(deps(store, iv), "META", DATE, 70000n, "C");
    expect(b.reused).toBe(true);
    expect(b.row).toEqual(a.row);
    expect(b.row.strikesCents).toEqual(a.row.strikesCents);
  });

  it("ORC-18 prev_close_cents is the value passed in (the previous official close)", async () => {
    const store = new MemoryStore();
    const r = await freezeStrikeInputs(deps(store, null), "NVDA", DATE, 19011n, null);
    expect(r.row.prevCloseCents).toBe(19011n);
  });

  it("an IV vendor error falls back to RV instead of failing the morning", async () => {
    const store = new MemoryStore();
    const iv = { atmImpliedVol: async () => { throw new Error("503"); } };
    const r = await freezeStrikeInputs({ ...deps(store, null), iv }, "META", DATE, 68000n, null);
    expect(r.row.volBasis).toBe("RV_FALLBACK");
  });
});

describe("Massive and Databento parsers (recorded fixtures, never the live API)", () => {
  const chain = [
    { implied_volatility: 0.3512, details: { strike_price: 680, expiration_date: "2026-11-27", contract_type: "call" } },
    { implied_volatility: 0.3488, details: { strike_price: 680, expiration_date: "2026-11-27", contract_type: "put" } },
    { implied_volatility: 0.3301, details: { strike_price: 685, expiration_date: "2026-11-27", contract_type: "call" } },
    { implied_volatility: 0.2900, details: { strike_price: 680, expiration_date: "2026-12-04", contract_type: "call" } },
    { implied_volatility: null, details: { strike_price: 675, expiration_date: "2026-11-27", contract_type: "call" } },
  ];

  it("ATM IV: nearest expiry, strike nearest the previous close, mean of call and put", () => {
    const iv = pickAtmIv(chain, 68110n)!;
    expect([iv.expiry, iv.strikeCents, iv.ivBps]).toEqual(["2026-11-27", 68000n, 3500n]);
    expect(pickAtmIv([], 68000n)).toBeNull();
  });

  it("decimal parsing is exact", () => {
    expect(fractionToBps("0.35125")).toBe(3513n);
    expect(fractionToBps(0.3512)).toBe(3512n);
    expect(toCents(685.12)).toBe(68512n);
    expect(toCents("685.1")).toBe(68510n);
    expect(toCents("685.1200")).toBe(68512n);
    expect(() => toCents("685.125")).toThrow(/whole cents/);
  });

  it("Massive open-close: official close parsed, 404 means not published", async () => {
    const fetchFn = (async (url: string) =>
      url.includes("/2026-11-25")
        ? new Response(JSON.stringify({ status: "OK", from: "2026-11-25", close: 685.12 }))
        : new Response("{}", { status: 404 })) as typeof fetch;
    const m = new MassiveClient({ apiKey: "k", baseUrl: "https://massive.test", fetch: fetchFn });
    expect((await m.officialClose("META", "2026-11-25"))!.cents).toBe(68512n);
    expect(await m.officialClose("META", "2026-11-26")).toBeNull();
  });

  it("Massive splits and dividends map to skip reasons", async () => {
    const fetchFn = (async (url: string) =>
      url.includes("/splits")
        ? new Response(JSON.stringify({ results: [{ split_from: 1, split_to: 10 }] }))
        : new Response(JSON.stringify({ results: [{ cash_amount: 3, dividend_type: "SC" }] }))) as typeof fetch;
    const m = new MassiveClient({ apiKey: "k", baseUrl: "https://massive.test", fetch: fetchFn });
    expect(await m.splits("NVDA", DATE)).toEqual([{ kind: "SPLIT" }]);
    expect(await m.dividends("MSFT", DATE)).toEqual([{ cashAmount: "3", special: true }]);
  });

  it("Databento statistics: last CLOSE_PRICE record wins; empty means not published", async () => {
    const body = [
      JSON.stringify({ hd: { ts_event: "1" }, stat_type: 1, price: "600.00" }),
      JSON.stringify({ hd: { ts_event: "2" }, stat_type: 11, price: "685.120000000" }),
    ].join("\n");
    let auth = "";
    const d = new DatabentoClient({
      apiKey: "db-key", baseUrl: "https://db.test",
      fetch: (async (_u: string, init?: RequestInit) => { auth = String((init?.headers as Record<string, string>).authorization); return new Response(body); }) as typeof fetch,
    });
    expect((await d.officialClose("META", DATE))!.cents).toBe(68512n);
    expect(auth).toBe(`Basic ${Buffer.from("db-key:").toString("base64")}`);
    const empty = new DatabentoClient({ apiKey: "k", fetch: (async () => new Response("")) as typeof fetch });
    expect(await empty.officialClose("META", DATE)).toBeNull();
  });
});
