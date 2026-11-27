/**
 * MER-48 spike: Massive vs Databento official-close agreement, publication latency, and
 * the gap to the Pyth update at the close. Writes one CSV row per ticker-day and prints a
 * recommended `close_tolerance_bps`.
 *
 *   MASSIVE_API_KEY=… DATABENTO_API_KEY=… node dist/scripts/close-spike.js history 2026-11-02 2026-11-25
 *   MASSIVE_API_KEY=… DATABENTO_API_KEY=… node dist/scripts/close-spike.js live
 *
 * `history` reads past days (agreement and Pyth gap). `live` starts polling both vendors at
 * the close and records how many seconds after the close each one first returns the
 * print (latency), stopping at close + 15 min. Run it on 5 trading days for the write-up.
 * Pyth feed ids come from PYTH_FEEDS (JSON: {"AAPL":"<hex>", ...}).
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { buildCalendarYear, TradingCalendar } from "../src/calendar.js";
import { HermesClient } from "../src/oracle/hermes.js";
import { etDate, IsoDate, systemClock } from "../src/time.js";
import { DatabentoClient } from "../src/vendors/databento.js";
import { MassiveClient, OfficialCloseSource } from "../src/vendors/massive.js";

const MAG7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];
const OUT = process.env.SPIKE_OUT ?? "close-spike.csv";

function need(n: string): string {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is required`);
  return v;
}

/** |a − b| / b in basis points, ×100 for two decimals, as a bigint. */
function gapCentiBps(a: bigint, b: bigint): bigint {
  const d = a > b ? a - b : b - a;
  return (d * 1_000_000n) / b;
}

async function main() {
  const [mode, from, to] = process.argv.slice(2);
  const massive = new MassiveClient({ apiKey: need("MASSIVE_API_KEY"), baseUrl: process.env.MASSIVE_BASE_URL });
  const databento = new DatabentoClient({ apiKey: need("DATABENTO_API_KEY"), dataset: process.env.DATABENTO_DATASET });
  const hermes = new HermesClient({ baseUrl: process.env.HERMES_URL ?? "https://hermes.pyth.network" });
  const feeds = JSON.parse(process.env.PYTH_FEEDS ?? "{}") as Record<string, string>;
  const y = new Date().getUTCFullYear();
  const cal = new TradingCalendar([...buildCalendarYear(y - 1), ...buildCalendarYear(y)]);
  if (!existsSync(OUT)) {
    writeFileSync(OUT, "date,symbol,massive_cents,databento_cents,agree,massive_latency_s,databento_latency_s,pyth_price,pyth_expo,pyth_conf,pyth_publish_offset_s,gap_official_vs_pyth_bps\n");
  }
  let worstGap = 0n;

  const row = async (date: IsoDate, sym: string, lat: { m: number | null; d: number | null }) => {
    const close = cal.closeTime(date);
    const [m, d] = await Promise.all([massive.officialClose(sym, date), databento.officialClose(sym, date)]);
    let pyth = "", expo = "", conf = "", off = "", gap = "";
    if (feeds[sym] && m) {
      const u = await hermes.updateAtOrAfter(feeds[sym]!, close);
      if (u) {
        pyth = u.priceRaw.toString();
        expo = String(u.expo);
        conf = u.conf.toString();
        off = String(u.publishTime - close);
        const official = u.expo <= -2 ? m.cents * 10n ** BigInt(-u.expo - 2) : m.cents / 10n ** BigInt(u.expo + 2);
        const g = gapCentiBps(official, u.priceRaw);
        if (g > worstGap) worstGap = g;
        gap = `${g / 100n}.${String(g % 100n).padStart(2, "0")}`;
      }
    }
    appendFileSync(OUT, [date, sym, m?.cents ?? "", d?.cents ?? "", m && d ? String(m.cents === d.cents) : "", lat.m ?? "", lat.d ?? "", pyth, expo, conf, off, gap].join(",") + "\n");
  };

  if (mode === "history") {
    for (const date of cal.dates().filter((x) => x >= need0(from) && x <= need0(to))) {
      for (const sym of MAG7) await row(date, sym, { m: null, d: null });
    }
  } else if (mode === "live") {
    const date = etDate(systemClock.now());
    const close = cal.closeTime(date);
    if (systemClock.now() < close) await systemClock.sleep(close - systemClock.now());
    const first = async (src: OfficialCloseSource, sym: string) => {
      while (systemClock.now() <= close + 900) {
        if (await src.officialClose(sym, date).catch(() => null)) return systemClock.now() - close;
        await systemClock.sleep(5);
      }
      return null;
    };
    await Promise.all(MAG7.map(async (sym) => {
      const [m, d] = await Promise.all([first(massive, sym), first(databento, sym)]);
      await row(date, sym, { m, d });
    }));
  } else {
    throw new Error("usage: close-spike.js history FROM TO | live");
  }
  // Recommendation: the worst observed gap with 50% headroom, at least the 20 bps default.
  const rec = (worstGap * 3n) / 200n / 100n + 1n;
  console.log(`worst official-vs-Pyth gap: ${worstGap / 100n}.${String(worstGap % 100n).padStart(2, "0")} bps; recommended close_tolerance_bps >= ${rec > 20n ? rec : 20n}`);
}

function need0(v: string | undefined): string {
  if (!v) throw new Error("usage: close-spike.js history FROM TO");
  return v;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
