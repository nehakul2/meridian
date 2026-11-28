/**
 * MER-83: concurrency and scale harness. Runs nightly (.github/workflows/load.yml), not on PRs.
 * Each budget is asserted with its threshold and written to a pass/fail report
 * (LOAD_REPORT, default tests/load/out/report.json, plus the GitHub step summary).
 *
 * LOAD_SCALE (default 1) multiplies request, client, fill and day counts; the nightly run uses
 * a larger scale. Latency budgets are measured on the server side of each request (Fastify's
 * elapsed time, gateway receive time) because the harness's own clients share the process.
 *
 * Matrix: CON-01, SCL-01, SCL-02, SCL-03, SCL-04, SCL-05, SCL-06, SCL-07, SCL-08, SCL-09, AST-08.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { haveProgram } from "../../scripts/__tests__/helpers/svm-cluster.js";
import { MAG7 } from "../../scripts/devnet/deploy.js";
import { tokenAmount } from "../../scripts/devnet/spl.js";
import type { MarketAccount } from "../../services/automation/src/chain/client.js";
import { coder } from "../../services/automation/src/chain/idl.js";
import { ata, configPda, seeded } from "../../services/automation/src/chain/pdas.js";
import { etToUnix } from "../../services/automation/src/time.js";
import { STREAM_KEY, STREAM_MAXLEN } from "../../services/shared/src/events.js";
import { K } from "../../services/shared/src/keys.js";
import { ixCancelAll, ixMint, ixPlaceOrder } from "../../services/txb/src/chain/ixs.js";
import { Stack, USDC } from "./harness.js";
import { drive, openLoop, percentile, Report } from "./stats.js";

const SCALE = Math.max(1, Number(process.env.LOAD_SCALE ?? 1));
/** API instances behind the load balancer that share SCL-01's 2,000 req/s. */
const API_INSTANCES = Math.max(1, Number(process.env.API_INSTANCES ?? 4));
const DATE = "2026-11-25";
const KEY = 20261125;
const CLOSE = etToUnix(DATE, 16, 0);
const ATM: Record<string, bigint> = { AAPL: 23_000n, MSFT: 41_000n, GOOGL: 17_000n, AMZN: 20_000n, NVDA: 14_000n, META: 60_000n, TSLA: 25_000n };
const strikesFor = (t: string) => [-3, -2, -1, 0, 1, 2, 3].map((k) => ATM[t]! + BigInt(k) * 500n);
const feedHex = (t: string) => Buffer.alloc(32, MAG7.indexOf(t) + 1).toString("hex");
const report = new Report();
const supply = (data: Uint8Array | undefined) => (data ? Buffer.from(data).readBigUInt64LE(36) : 0n);

let s: Stack;
let markets: MarketAccount[] = [];
/** Markets the CON-01 burst and the SCL-06 deep book fill to the brim; other scenarios use `quiet`. */
let busy: MarketAccount[] = [];
let quiet: MarketAccount[] = [];
let apiTimes: number[];
let txbTimes: number[];
let maker: Keypair;

describe.skipIf(!haveProgram)("MER-83 load harness", () => {
  beforeAll(async () => {
    s = await Stack.start({ date: DATE, withPg: true });
    apiTimes = s.apiTimes;
    txbTimes = s.txbTimes;
    // Every ticker has a price from the start (the settle steps read the update at close).
    for (const t of MAG7) s.cluster.oracle.set(feedHex(t), ATM[t]! * 1_000n);
  });

  afterAll(async () => {
    const path = process.env.LOAD_REPORT ?? new URL("./out/report.json", import.meta.url).pathname;
    report.facts.scale = SCALE;
    report.write(path);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Meridian load (scale ${SCALE})\n\n${report.markdown()}\n`);
    }
    console.log(`\n${report.markdown()}\n`);
    await s?.stop();
  });

  it("SCL-05 one morning run creates 7 tickers x 7 strikes before 08:30 ET, rent logged", async () => {
    await s.cluster.waitUntil(etToUnix(DATE, 8, 0));
    const payer0 = await s.cluster.lamports(s.keys.payer.publicKey);
    const t0 = performance.now();
    markets = await s.morning(DATE, KEY, MAG7, strikesFor);
    const wallS = (performance.now() - t0) / 1000;
    const spent = payer0 - (await s.cluster.lamports(s.keys.payer.publicKey));
    expect(markets).toHaveLength(49);
    busy = [markets.find((x) => x.ticker === "AAPL" && x.strikeCents === ATM.AAPL)!, markets.find((x) => x.ticker === "NVDA" && x.strikeCents === ATM.NVDA)!];
    quiet = markets.filter((m) => !busy.includes(m));
    report.facts.morning = { markets: markets.length, wallS, payerSpentSol: spent / 1e9, perMarketSol: spent / 49 / 1e9 };
    // 08:00 start, 08:30 deadline: the run must take less than 30 minutes of wall time.
    expect(report.budget("SCL-05", "morning wall time (49 markets)", wallS, 1800, "s")).toBe(true);
    expect(await s.redis.scard(K.dayMarkets(KEY))).toBe(49);
  });

  it("CON-01 1,000 mixed mints, orders and cancels from 200 wallets on one market keep every invariant", async () => {
    await s.cluster.waitUntil(etToUnix(DATE, 9, 31));
    const m = busy[0]!;
    const wallets: Keypair[] = [];
    const funded = 1_000n * USDC;
    for (let i = 0; i < 200; i++) wallets.push(await s.user(funded));
    let rnd = 42;
    const rand = (n: number) => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) % n);
    let ok = 0, failed = 0;
    // No clock movement: every transaction lands in the same few slots.
    for (let i = 0; i < 1_000; i++) {
      const u = wallets[rand(wallets.length)]!;
      const k = rand(10);
      const ix = k < 3 ? ixMint(u.publicKey, m, s.usdc, BigInt(1 + rand(5)))
        : k < 6 ? ixPlaceOrder(u.publicKey, m, s.usdc, "BID", 30 + rand(20), BigInt(1 + rand(5)), "GTC", BigInt(i), [])
        : k < 9 ? ixPlaceOrder(u.publicKey, m, s.usdc, "ASK", 51 + rand(20), BigInt(1 + rand(3)), "GTC", BigInt(i), [])
        : ixCancelAll(u.publicKey, m, s.usdc);
      try {
        await s.send([ix], [u]);
        ok++;
      } catch {
        failed++; // e.g. an ask without enough Yes: the whole transaction is rejected
      }
    }
    await s.drain();
    // Invariants from chain state: USDC and Yes/No conserved, vault >= accounted, supplies equal.
    const after = (await s.chain.market(m.address))!;
    const bal = async (k: PublicKey) => tokenAmount((await s.cluster.getAccount(k))?.data);
    let users = 0n, usersYes = 0n, usersNo = 0n;
    for (const w of wallets) {
      users += await bal(ata(w.publicKey, s.usdc));
      usersYes += await bal(ata(w.publicKey, m.yesMint));
      usersNo += await bal(ata(w.publicKey, m.noMint));
    }
    const vault = await bal(m.vault);
    const quote = await bal(seeded("quote", m.address));
    const base = await bal(seeded("base", m.address));
    const yesSupply = supply((await s.cluster.getAccount(m.yesMint))?.data);
    const noSupply = supply((await s.cluster.getAccount(m.noMint))?.data);
    expect(users + vault + quote).toBe(funded * 200n); // INV: no USDC created or lost
    expect(vault >= after.collateralAccounted).toBe(true); // D17
    expect(after.collateralAccounted).toBe(after.pairsOutstanding * USDC);
    expect(yesSupply).toBe(after.pairsOutstanding);
    expect(noSupply).toBe(after.pairsOutstanding);
    expect(usersYes + base).toBe(yesSupply); // Yes in wallets or escrowed in asks
    expect(usersNo).toBe(noSupply);
    // The read model agrees with the chain after the burst.
    expect(BigInt((await s.redis.hget(K.mkt(m.address.toBase58()), "seq")) ?? "-1")).toBe(after.seq);
    report.facts.con01 = { ok, failed, pairs: after.pairsOutstanding.toString() };
    expect(report.budget("CON-01", "invariant violations after 1,000 txs", 0, 1, "count")).toBe(true);
  });

  it("SCL-01 / SCL-02 API reads p99 < 20 ms and Tx Builder builds p99 < 30 ms on a full day", async () => {
    // A maker quotes the quiet books so the reads return real depth.
    maker = await s.user(1_000_000n * USDC);
    for (const m of quiet) {
      await s.send([ixMint(maker.publicKey, m, s.usdc, 200n)], [maker]);
      for (const [side, px] of [["BID", 40], ["BID", 38], ["ASK", 60], ["ASK", 62]] as const) {
        await s.send([ixPlaceOrder(maker.publicKey, m, s.usdc, side, px, 20n, "GTC", 1n, [])], [maker]);
      }
    }
    await s.drain();
    const ids = quiet.map((m) => m.address.toBase58());
    const urls = (i: number) => {
      const id = ids[i % ids.length]!;
      const t = MAG7[i % 7]!;
      return [`/v1/tickers/${t}/markets?date=${DATE}`, `/v1/markets/${id}`, `/v1/markets/${id}/book`, `/v1/markets/${id}/book?view=NO`,
        `/v1/markets/${id}/trades`, "/v1/status", "/v1/tickers"][i % 7]!;
    };
    apiTimes.length = 0;
    for (const k of Object.keys(s.apiByRoute)) delete s.apiByRoute[k];
    // Matrix: 2,000 req/s of mixed GETs across the API tier. The harness runs one API instance
    // in-process beside the whole stack, so it drives that instance at its share:
    // 2,000 / API_INSTANCES (default 4) req/s. docs/phase8-coverage.md explains the split.
    const perInstance = Math.round(2_000 / API_INSTANCES);
    const n = perInstance * 4 * SCALE;
    const reads = await openLoop(Array.from({ length: n }, (_, i) => ({ url: `${s.apiUrl}${urls(i)}` })), perInstance);
    report.facts.scl01 = { firstError: reads.firstError, requests: n, achievedRps: Math.round(n / reads.seconds), clientP99: percentile(reads.latencies, 99), serverP50: percentile(apiTimes, 50) };
    report.facts.scl01ByRoute = Object.fromEntries(Object.entries(s.apiByRoute).map(([k, v]) => [k, { n: v.length, p50: percentile(v, 50), p99: percentile(v, 99) }]));
    expect(reads.errors).toBe(0);
    expect(report.budget("SCL-01", `API read p99 (server), one instance at ${perInstance} req/s`, percentile(apiTimes, 99), 20, "ms", "lt", `2,000 req/s over ${API_INSTANCES} instances`)).toBe(true);

    // Matrix: 500 builds/s.
    const taker = await s.user(10_000n * USDC);
    txbTimes.length = 0;
    const builds = 1_000 * SCALE;
    const res = await openLoop(Array.from({ length: builds }, (_, i) => ({
      url: `${s.txbUrl}/v1/tx/trade`, method: "POST" as const,
      body: JSON.stringify({
        owner: taker.publicKey.toBase58(), marketId: ids[i % ids.length], intent: ["BUY_YES", "BUY_NO"][i % 2], orderType: ["LIMIT", "MARKET"][(i >> 1) % 2],
        qty: 1 + (i % 5), priceCents: 61, // Yes asks rest at 60, Yes bids at 40 (No at 60)
      }),
    })), Number(process.env.TXB_RPS ?? 500));
    report.facts.scl02 = { builds, rejected: res.errors, firstError: res.firstError, achievedRps: Math.round(builds / res.seconds), serverP50: percentile(txbTimes, 50) };
    expect(res.errors).toBe(0);
    expect(report.budget("SCL-02", "Tx Builder p99 (server) at 500 builds/s", percentile(txbTimes, 99), 30, "ms")).toBe(true);
  });

  it("SCL-03 / SCL-07 fill to WS client < 150 ms after confirmation with continuous seqs; event to PG < 2 s", async () => {
    const nClients = 200 * SCALE;
    const books = quiet.map((m) => m.address.toBase58());
    interface Rx { seq: bigint; prev: bigint; at: number }
    const got: Map<string, Rx[]>[] = [];
    const sockets: WebSocket[] = [];
    for (let i = 0; i < nClients; i++) {
      const ws = new WebSocket(s.wsUrl);
      const mine = new Map<string, Rx[]>();
      got.push(mine);
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString()) as { type: string; channel?: string; seq?: string; prev_seq?: string };
        if (!m.channel) return;
        const list = mine.get(m.channel) ?? [];
        if (m.type === "book_snapshot") list.push({ seq: BigInt(m.seq!), prev: -1n, at: performance.now() });
        if (m.type === "book_delta") list.push({ seq: BigInt(m.seq!), prev: BigInt(m.prev_seq!), at: performance.now() });
        mine.set(m.channel, list);
      });
      await new Promise((r) => ws.once("open", r));
      ws.send(JSON.stringify({ op: "subscribe", channels: [`book:${books[i % books.length]}`] }));
      sockets.push(ws);
    }
    await new Promise((r) => setTimeout(r, 500));

    const taker = await s.user(100_000n * USDC);
    s.consumer?.committedAt.clear(); // SCL-07 measures this burst only
    const burstStart = Date.now();
    const lat: number[] = [];
    const fills = 100 * SCALE;
    for (let i = 0; i < fills; i++) {
      const m = quiet[i % quiet.length]!;
      const ch = `book:${m.address.toBase58()}`;
      await s.send([ixPlaceOrder(taker.publicKey, m, s.usdc, "BID", 60, 1n, "IOC", BigInt(i), [maker.publicKey])], [taker]);
      const confirmed = performance.now();
      const seq = (await s.chain.market(m.address))!.seq;
      // Wait until every client on this book has the delta for this fill (or 1 s).
      const subs = got.filter((_, j) => books[j % books.length] === m.address.toBase58());
      const t0 = Date.now();
      while (Date.now() - t0 < 1_000 && subs.some((g) => !(g.get(ch) ?? []).some((x) => x.seq >= seq))) await new Promise((r) => setTimeout(r, 2));
      for (const g of subs) {
        const rx = (g.get(ch) ?? []).find((x) => x.seq >= seq);
        lat.push(rx ? rx.at - confirmed : 1_000);
      }
      await new Promise((r) => setTimeout(r, 20)); // ~50 fills/s
    }
    // Every client's deltas chain from its snapshot: no dropped deltas.
    let gaps = 0;
    for (const g of got) for (const list of g.values()) for (let i = 1; i < list.length; i++) if (list[i]!.prev !== list[i - 1]!.seq) gaps++;
    for (const w of sockets) w.close();
    report.facts.scl03 = { clients: nClients, fills, samples: lat.length, p50: percentile(lat, 50), p99: percentile(lat, 99) };
    expect(report.budget("SCL-03", "fill confirmed -> WS client p95", percentile(lat, 95), 150, "ms")).toBe(true);
    expect(report.budget("SCL-03", "seq gaps seen by clients", gaps, 1, "count")).toBe(true);

    if (!s.consumer) {
      report.facts.scl07 = "skipped: no Postgres";
      return;
    }
    await s.consumer.drain();
    const lags = [...s.consumer.committedAt.entries()].filter(([id]) => Number(id.split("-")[0]) >= burstStart).map(([id, at]) => at - Number(id.split("-")[0]));
    const len = await s.redis.xlen(STREAM_KEY);
    report.facts.scl07 = { entries: lags.length, streamLen: len };
    expect(lags.length).toBeGreaterThan(0);
    expect(report.budget("SCL-07", "event -> PG p95 (stream append to commit)", percentile(lags, 95), 2_000, "ms", "lt", "PG Writer drained after the burst")).toBe(true);
    expect(len).toBeLessThan(STREAM_MAXLEN);
  });

  it("SCL-06 deep book: an IOC sweeping every ask level stops at the 32-fill cap with a partial fill, within compute", async () => {
    const m = busy[1]!;
    const makers: Keypair[] = [];
    for (let i = 0; i < 8; i++) makers.push(await s.user(100_000n * USDC));
    for (const mk of makers) await s.send([ixMint(mk.publicKey, m, s.usdc, 200n)], [mk]);
    // Rings full: 8 orders at every bid level 1..49 and every ask level 51..99 (784 resting orders).
    for (let px = 1; px <= 99; px++) {
      if (px === 50) continue;
      for (const mk of makers) await s.send([ixPlaceOrder(mk.publicKey, m, s.usdc, px < 50 ? "BID" : "ASK", px, 1n, "GTC", BigInt(px), [])], [mk]);
    }
    const book = (await s.chain.book(m))!;
    const resting = book.orders.filter((o) => o.price !== 50);
    report.facts.scl06 = { restingBefore: resting.length };
    const taker = await s.user(100_000n * USDC);
    let cu = 0n;
    const prev = s.cluster.onLanded!;
    s.cluster.onLanded = (tx, res) => {
      cu = res.computeUnitsConsumed();
      prev(tx, res);
    };
    let outcome = "landed";
    let filled = 0n;
    try {
      // Try to sweep 49 levels x 8 orders = 392 contracts, worst price 99. Without the cap this
      // aborted at about 50 fills (Anchor's 32 KiB event heap), not on compute.
      const yes0 = tokenAmount((await s.cluster.getAccount(ata(taker.publicKey, m.yesMint)))?.data);
      await s.send([ixPlaceOrder(taker.publicKey, m, s.usdc, "BID", 99, 400n, "IOC", 1n, makers.map((k) => k.publicKey))], [taker], 1_400_000);
      filled = tokenAmount((await s.cluster.getAccount(ata(taker.publicKey, m.yesMint)))?.data) - yes0;
    } catch (e) {
      outcome = `rejected: ${(e as Error).message.split("\n")[0]}`;
    } finally {
      s.cluster.onLanded = prev;
    }
    const after = (await s.chain.book(m))!;
    const asksLeft = after.orders.filter((o) => o.side === 1).length;
    report.facts.scl06 = { ...(report.facts.scl06 as object), outcome, filled: Number(filled), computeUnits: Number(cu), asksLeft };
    expect(outcome).toBe("landed");
    expect(filled).toBe(32n); // MAX_FILLS_PER_IX; the IOC remainder is cancelled
    expect(asksLeft).toBe(392 - 32);
    expect(report.budget("SCL-06", "CU for a capped sweep (32 fills over 4 levels)", Number(cu), 1_400_000, "CU", "lt", "IOC partial fill at MAX_FILLS_PER_IX")).toBe(true);
  });

  it("SCL-09 the Indexer catches up after an outage with no seq gaps left", async () => {
    s.live = false;
    const taker = await s.user(100_000n * USDC);
    const n = 300 * SCALE;
    for (let i = 0; i < n; i++) {
      const m = quiet[i % quiet.length]!;
      await s.send([ixPlaceOrder(taker.publicKey, m, s.usdc, "BID", 2 + (i % 20), 1n, "GTC", BigInt(i), [])], [taker]);
    }
    const t0 = performance.now();
    s.live = true;
    const r = await s.indexer.backfill();
    const catchUpS = (performance.now() - t0) / 1000;
    expect(r.signatures).toBeGreaterThanOrEqual(n);
    expect(Number(await s.redis.get(K.slot))).toBe(s.source.txs.at(-1)!.slot);
    let mismatched = 0;
    for (const m of markets) {
      const chainSeq = (await s.chain.market(m.address))!.seq;
      if (BigInt((await s.redis.hget(K.mkt(m.address.toBase58()), "seq")) ?? "-1") !== chainSeq) mismatched++;
    }
    report.facts.scl09 = { missedTxs: n, backfilled: r.signatures, appended: r.appended };
    expect(report.budget("SCL-09", `catch-up after ${n} missed txs`, catchUpS, 120, "s")).toBe(true);
    expect(report.budget("SCL-09", "markets whose read-model seq differs from chain", mismatched, 1, "count")).toBe(true);
  });

  it("SCL-04 the 16:00 surge (reads x10, 500 cancels) does not delay recording or settling", async () => {
    // 500 cancels just before the close.
    const cancellers: Keypair[] = [];
    for (let i = 0; i < 50; i++) cancellers.push(await s.user(1_000n * USDC));
    await s.cluster.waitUntil(CLOSE - 60);
    const cancelTargets: [Keypair, MarketAccount][] = [];
    for (let i = 0; i < 500; i++) {
      const u = cancellers[i % 50]!, m = quiet[i % quiet.length]!;
      await s.send([ixPlaceOrder(u.publicKey, m, s.usdc, "BID", 10 + (i % 20), 1n, "GTC", BigInt(i), [])], [u]);
      cancelTargets.push([u, m]);
    }
    let stop = false;
    let reads = 0;
    const surge = (async () => {
      const ids = markets.map((m) => m.address.toBase58());
      await drive(1e9, 64, async (i) => {
        if (stop) throw new Error("stop");
        const r = await fetch(`${s.apiUrl}/v1/markets/${ids[i % 49]}/book`);
        await r.arrayBuffer();
        reads++;
      }).catch(() => undefined);
    })();
    await s.cluster.waitUntil(CLOSE - 1);
    const t0 = performance.now();
    for (const [u, m] of cancelTargets) {
      await s.send([ixCancelAll(u.publicKey, m, s.usdc)], [u]).catch(() => undefined);
      await new Promise((r) => setImmediate(r)); // the stand-in chain runs in-process: let the surge's reads interleave
    }
    // Close: the settler records all 7 tickers from the update stamped at close_time.
    await s.cluster.waitUntil(CLOSE + 5);
    const cfgRaw = (await s.cluster.getAccount(configPda()))!;
    const mode = Object.keys((coder.accounts.decode("Config", Buffer.from(cfgRaw.data)) as { close_source_mode: object }).close_source_mode)[0]!;
    const recStart = performance.now();
    for (const t of MAG7) {
      s.cluster.oracle.set(feedHex(t), ATM[t]! * 1_000n + 12_000n); // ATM + $0.12, expo -5
      const u = (await s.cluster.oracle.updateAtOrAfter(feedHex(t), CLOSE))!;
      const td = s.tickerDays.find((x) => x.ticker === t && x.date === KEY)!;
      await s.cluster.postAndConsume({ vaa: u.vaa } as never, feedHex(t), s.keys.settler, (acct) => [
        s.chain.ixRecordClose(new PublicKey(td.address), acct, mode.toLowerCase() === "attestedchecked" ? { price: u.priceRaw, expo: u.expo } : null),
      ]);
    }
    const recordS = (performance.now() - recStart) / 1000;
    // Final after the dispute window, then every strike settles.
    await s.cluster.waitUntil(CLOSE + 5 + 1_200);
    const setStart = performance.now();
    for (const t of MAG7) await s.chain.finalizeClose((await s.chain.tickerDay(t, KEY))!);
    for (const m of markets) await s.chain.settleMarket(m);
    const settleS = (performance.now() - setStart) / 1000;
    stop = true;
    await surge;
    await s.drain();
    const settled = (await Promise.all(markets.map((m) => s.chain.market(m.address)))).filter((m) => m!.status === "Settled").length;
    report.facts.scl04 = { surgeReads: reads, cancelsS: (performance.now() - t0) / 1000, recordS, settleS, settled };
    expect(settled).toBe(49);
    expect(report.budget("SCL-04", "all 7 closes recorded under surge (work time)", recordS, 180, "s")).toBe(true);
    expect(report.budget("SCL-04", "all 49 strikes settled after final (work time)", settleS, 600, "s")).toBe(true);
  });

  it("SCL-08 state growth: book rent comes back every day and the residual matches the per-day estimate", async () => {
    const days = 3 * SCALE;
    const perDay: number[] = [];
    let date = "2026-12-01";
    for (let d = 0; d < days; d++) {
      const key = Number(date.replaceAll("-", ""));
      const close = etToUnix(date, 16, 0);
      await s.cluster.waitUntil(etToUnix(date, 8, 0));
      const ms = await s.morning(date, key, MAG7, strikesFor, close);
      await s.cluster.waitUntil(close + 5);
      for (const t of MAG7) {
        const u = (await s.cluster.oracle.updateAtOrAfter(feedHex(t), close))!;
        const td = s.tickerDays.find((x) => x.ticker === t && x.date === key)!;
        await s.cluster.postAndConsume({ vaa: u.vaa } as never, feedHex(t), s.keys.settler, (acct) => [s.chain.ixRecordClose(new PublicKey(td.address), acct, { price: u.priceRaw, expo: u.expo })]);
      }
      await s.cluster.waitUntil(close + 5 + 1_200);
      for (const t of MAG7) await s.chain.finalizeClose((await s.chain.tickerDay(t, key))!);
      for (const m of ms) await s.chain.settleMarket(m);
      for (const m of ms) await s.chain.closeBook(m);
      // What stays allocated for the day once the books are closed (A27, D29).
      let residual = 0;
      for (const m of ms) {
        expect(await s.cluster.getAccount(m.book)).toBeNull();
        for (const k of [m.address, m.yesMint, m.noMint, m.vault, seeded("base", m.address), seeded("quote", m.address)]) residual += (await s.cluster.getAccount(k))?.lamports ?? 0;
      }
      for (const t of MAG7) residual += (await s.chain.tickerDay(t, key)) ? (await s.cluster.getAccount((await s.chain.tickerDay(t, key))!.address))!.lamports : 0;
      perDay.push(residual);
      const next = new Date(`${date}T12:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      date = next.toISOString().slice(0, 10);
    }
    const bookRent = await s.cluster.rentExempt((await import("../../services/automation/src/chain/book.js")).BOOK_LEN);
    report.facts.scl08 = { days, residualPerDaySol: perDay[0]! / 1e9, bookRentReclaimedPerDaySol: (bookRent * 49) / 1e9, projected250DaysSol: (perDay[0]! * 250) / 1e9 };
    expect(new Set(perDay).size).toBe(1); // the same every day
    expect(report.budget("SCL-08", "residual rent per day (49 markets)", perDay[0]! / 1e9, RESIDUAL_PER_DAY_SOL + 0.01, "SOL", "lt", `documented ${RESIDUAL_PER_DAY_SOL} SOL`)).toBe(true);
  });

  it("AST-08 is not measured yet: the assistant tier is Phase 10", () => {
    report.rows.push({ case: "AST-08", metric: "assistant load vs API p99", value: NaN, budget: 0, unit: "", op: "lt", pass: true, note: "n/a until Phase 10" });
  });
});

/** docs/phase8-coverage.md "State growth": rent left per trading day (7 ticker-days + 49 markets) after close_book. */
const RESIDUAL_PER_DAY_SOL = Number(process.env.RESIDUAL_PER_DAY_SOL ?? 0.59);
