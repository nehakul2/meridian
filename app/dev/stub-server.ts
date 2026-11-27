/**
 * Local stand-in for the Phase 6 services, for `npm run dev`, screenshots and the Playwright
 * suite. One port serves:
 *
 *   - the REST API routes the frontend calls (spec 7.1 to 7.3), same paths and shapes;
 *   - the Tx Builder routes (spec 7.4): real unsigned v0 transactions (a single stub
 *     instruction carrying an op id), with the builder's guards and `summary.copy`;
 *   - the WebSocket gateway protocol (spec 7.5): book snapshot then deltas with `prev_seq`,
 *     trades, market status, `px` and the authenticated `user` channel;
 *   - a minimal JSON-RPC (getGenesisHash, token balances, sendTransaction,
 *     getSignatureStatuses, getBlockHeight). A sent transaction must carry a valid wallet
 *     signature; the stub then applies its op as the program would and pushes the events.
 *
 * Shared pieces (SIWS message and check, JWT, summary copy, No view, fees) are imported from
 * services/shared, so they are the exact code the real services run. It is not the program:
 * matching is against a synthetic market maker only. Control routes under /__stub/ let the
 * tests set the clock, phase, pause, settle markets and fail the next transaction.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { WebSocketServer, type WebSocket } from "ws";
import { signJwt, siwsMessage, verifyEd25519, verifyJwt } from "../../services/shared/src/auth";
import { centsToDollars, noView, question, summaryCopy, takerFee, type Intent } from "../../services/shared/src/market";

const PORT = Number(process.env.STUB_PORT ?? 8787);
const DOMAIN = process.env.STUB_DOMAIN ?? "localhost:3000";
const JWT_SECRET = "stub-secret-not-for-production";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

const TICKERS: [string, number][] = [["AAPL", 232.4], ["MSFT", 512.1], ["GOOGL", 178.25], ["AMZN", 214.6], ["NVDA", 186.3], ["META", 684.21], ["TSLA", 342.8]];

// ---------- helpers ----------
const seeded = (s: string) => Keypair.fromSeed(createHash("sha256").update(s).digest()).publicKey.toBase58();
const STUB_PROGRAM = new PublicKey(seeded("meridian-stub-program"));
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function etParts(ms: number) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return { y: g("year"), m: g("month"), d: g("day"), h: g("hour"), min: g("minute") };
}
/** Unix ms of HH:MM America/New_York on the ET date of `ms`. */
function etAt(ms: number, h: number, min: number) {
  const { y, m, d } = etParts(ms);
  let guess = Date.UTC(y, m - 1, d, h + 5, min);
  for (let i = 0; i < 2; i++) {
    const e = etParts(guess);
    guess -= ((e.h - h) * 60 + (e.min - min)) * 60_000;
  }
  return guess;
}
function erf(x: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const ncdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));

// ---------- state ----------
interface Level { mm: number; users: { owner: string; orderId: string; qty: number }[] }
interface Mkt {
  id: string; symbol: string; strikeCents: number; status: "TRADING" | "HALTED" | "SETTLED" | "VOID"; outcome: "YES" | "NO" | "VOID" | null;
  bids: Map<number, Level>; asks: Map<number, Level>; seq: number; last: number | null; volume: number; pairs: number; yesMint: string; noMint: string; date: string;
}
interface Pos { yes: number; no: number; yesCost: bigint; noCost: bigint; realized: bigint; ledgerUsdc: bigint; ledgerYes: number; pendingNo: number; redeemed: boolean }
interface Ord { marketId: string; orderId: string; intent: Intent; bookSide: "BID" | "ASK"; yesPriceCents: number; priceCents: number; qty: number; filled: number; tif: string; status: string; placedAt: string; signature: string | null }
interface Hist { time: string; marketId: string; intent: string; qty: number; priceCents: number | null; fee: string; usdc: string | null; signature: string }
interface Opts { phase: "PRE_OPEN" | "MINT_ONLY" | "TRADING" | "HALTED" | "SETTLED"; halfDay: boolean; seed: "none" | "demo"; paused: boolean; live: boolean; closeInS?: number; usdc: string; feeBps: number }

const DEFAULTS: Opts = { phase: "TRADING", halfDay: false, seed: "demo", paused: false, live: true, usdc: "1000000000", feeBps: 0 };

let opts: Opts = { ...DEFAULTS };
let clockOffset = 0; // server time − real time
let day = { date: "", mintOpen: 0, open: 0, close: 0 };
let markets = new Map<string, Mkt>();
let px = new Map<string, { price: number; prev: number; t: number }>();
let positions = new Map<string, Map<string, Pos>>();
let orders = new Map<string, Ord[]>();
let history = new Map<string, Hist[]>();
let balances = new Map<string, bigint>();
let prefs = new Map<string, { defaultView: "YES" | "NO"; slippageCents: number }>();
let seededOwners = new Set<string>();
let pendingOps = new Map<string, Record<string, unknown>>();
let sigs = new Map<string, { at: number; err: unknown }>();
let nonces = new Map<string, { owner: string; message: string; exp: number }>();
let settlement = new Map<string, { closePrice: string; status: string }>();
let failNext: string | null = null;
let rejectedSigs = 0;
let nextOrderId = 1000;
const now = () => Date.now() + clockOffset;

function reset(o: Partial<Opts> = {}) {
  opts = { ...DEFAULTS, ...o };
  const real = Date.now();
  // Serve a realistic session: the ET date of today, with server time placed in the chosen phase.
  const open = etAt(real, 9, 30);
  const close = opts.halfDay ? etAt(real, 13, 0) : etAt(real, 16, 0);
  const target =
    opts.closeInS !== undefined ? close - opts.closeInS * 1000
    : opts.phase === "PRE_OPEN" ? etAt(real, 7, 50)
    : opts.phase === "MINT_ONLY" ? etAt(real, 9, 5)
    : opts.phase === "TRADING" ? close - (opts.halfDay ? 97 : 137) * 60_000 - 3_000
    : opts.phase === "HALTED" ? close + 3 * 60_000
    : close + 45 * 60_000;
  clockOffset = target - real;
  const { y, m, d } = etParts(real);
  day = { date: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, mintOpen: etAt(real, 8, 30), open, close };
  markets = new Map(); px = new Map(); positions = new Map(); orders = new Map(); history = new Map(); balances = new Map();
  prefs = new Map(); seededOwners = new Set(); pendingOps = new Map(); sigs = new Map(); nonces = new Map(); settlement = new Map();
  failNext = null;
  rejectedSigs = 0;
  const hoursLeft = Math.max(0.05, (day.close - now()) / 3_600_000);
  for (const [i, [sym, base]] of TICKERS.entries()) {
    const r = rng(i * 7919 + 17);
    const price = Math.round(base * (1 + (r() - 0.5) * 0.004) * 100) / 100;
    px.set(sym, { price, prev: Math.round(base * (1 - (r() - 0.45) * 0.02) * 100) / 100, t: now() });
    const step = base > 400 ? 10 : base > 150 ? 5 : 2.5;
    const atm = Math.round(base / step) * step;
    for (let k = -3; k <= 3; k++) {
      const strike = atm + k * step;
      const strikeCents = Math.round(strike * 100);
      const sigma = 0.03 * Math.sqrt(hoursLeft / 6.5);
      const fair = Math.min(97, Math.max(3, Math.round(ncdf(Math.log(price / strike) / sigma) * 100)));
      const id = seeded(`mkt:${sym}:${strikeCents}`);
      const mk: Mkt = { id, symbol: sym, strikeCents, status: "TRADING", outcome: null, bids: new Map(), asks: new Map(), seq: 100 + Math.floor(r() * 900),
        last: fair, volume: Math.floor(r() * 30000) + 1200, pairs: 0, yesMint: seeded(`yes:${id}`), noMint: seeded(`no:${id}`), date: day.date };
      const spread = 1 + Math.floor(r() * 3);
      const bid0 = Math.max(1, fair - Math.ceil(spread / 2));
      const ask0 = Math.min(99, bid0 + spread);
      for (let j = 0; j < 7; j++) {
        if (bid0 - j >= 1) mk.bids.set(bid0 - j, { mm: Math.floor(200 + r() * 1800) * (j === 0 ? 1 : 1 + j * 0.3) | 0, users: [] });
        if (ask0 + j <= 99) mk.asks.set(ask0 + j, { mm: Math.floor(200 + r() * 1800) * (j === 0 ? 1 : 1 + j * 0.3) | 0, users: [] });
      }
      mk.pairs = Math.floor(mk.volume / 2);
      markets.set(id, mk);
    }
  }
  if (opts.phase === "SETTLED") for (const m of markets.values()) settleMarket(m, false);
  else if (opts.phase === "HALTED") for (const m of markets.values()) m.status = "HALTED";
}

const mktsFor = (sym: string) => [...markets.values()].filter((m) => m.symbol === sym).sort((a, b) => a.strikeCents - b.strikeCents);
const findMkt = (sym: string, strike: number) => mktsFor(sym).find((m) => m.strikeCents === Math.round(strike * 100))!;

function settleMarket(m: Mkt, publish = true) {
  const p = px.get(m.symbol)!;
  m.status = "SETTLED";
  m.outcome = Math.round(p.price * 100) >= m.strikeCents ? "YES" : "NO";
  settlement.set(m.symbol, { closePrice: p.price.toFixed(2), status: "FINAL" });
  if (publish) publish_(`market:${m.id}`, { type: "market_status", status: "SETTLED", outcome: m.outcome, seq: String(m.seq) });
}

function pos(owner: string, m: string): Pos {
  let mp = positions.get(owner);
  if (!mp) positions.set(owner, (mp = new Map()));
  let p = mp.get(m);
  if (!p) mp.set(m, (p = { yes: 0, no: 0, yesCost: 0n, noCost: 0n, realized: 0n, ledgerUsdc: 0n, ledgerYes: 0, pendingNo: 0, redeemed: false }));
  return p;
}

/** A plausible account for the demo: open Yes and No, a pending Buy No, unclaimed proceeds, and yesterday's settled contracts. */
function ensureUser(owner: string) {
  if (seededOwners.has(owner)) return;
  seededOwners.add(owner);
  balances.set(owner, BigInt(opts.usdc));
  prefs.set(owner, { defaultView: "YES", slippageCents: 2 });
  if (opts.seed !== "demo") return;
  const t0 = now();
  const h = (mins: number) => iso(t0 - mins * 60_000);
  const sig = () => bs58.encode(randomBytes(64));
  const meta = findMkt("META", 680);
  const nvda = findMkt("NVDA", 190);
  const aapl = findMkt("AAPL", 235);
  Object.assign(pos(owner, meta.id), { yes: 150, yesCost: 87_600_000n, ledgerUsdc: 12_400_000n });
  Object.assign(pos(owner, nvda.id), { no: 80, noCost: 33_600_000n, realized: 4_200_000n });
  const ap = pos(owner, aapl.id);
  const yesPx = 65;
  Object.assign(ap, { yes: 40, no: 40, pendingNo: 40, noCost: 40_000_000n });
  const oid = String(nextOrderId++);
  addUserOrder(aapl, "ASK", yesPx, owner, oid, 40);
  orders.set(owner, [{ marketId: aapl.id, orderId: oid, intent: "BUY_NO", bookSide: "ASK", yesPriceCents: yesPx, priceCents: 100 - yesPx, qty: 40, filled: 0, tif: "GTC", status: "OPEN", placedAt: h(22), signature: sig() }]);
  // Yesterday: one winner to redeem, one loser.
  const yday = new Date(Date.parse(day.date) - 86_400_000).toISOString().slice(0, 10);
  for (const [sym, strike, side, qty, cost, outcome] of [["TSLA", 335, "YES", 50, 31_000_000n, "YES"], ["MSFT", 520, "NO", 60, 27_600_000n, "YES"]] as const) {
    const id = seeded(`mkt:${sym}:${strike * 100}:prev`);
    if (!markets.has(id)) {
      markets.set(id, { id, symbol: sym, strikeCents: strike * 100, status: "SETTLED", outcome, bids: new Map(), asks: new Map(), seq: 9000, last: outcome === "YES" ? 99 : 1, volume: 18400, pairs: 9200, yesMint: seeded(`yes:${id}`), noMint: seeded(`no:${id}`), date: yday });
    }
    const p = pos(owner, id);
    if (side === "YES") Object.assign(p, { yes: qty, yesCost: cost });
    else Object.assign(p, { no: qty, noCost: cost });
  }
  history.set(owner, [
    { time: h(22), marketId: aapl.id, intent: "BUY_NO", qty: 0, priceCents: 35, fee: "0", usdc: null, signature: orders.get(owner)![0]!.signature! },
    { time: h(48), marketId: nvda.id, intent: "SELL_NO", qty: 20, priceCents: 63, fee: "0", usdc: null, signature: sig() },
    { time: h(95), marketId: nvda.id, intent: "BUY_NO", qty: 100, priceCents: 42, fee: "0", usdc: null, signature: sig() },
    { time: h(130), marketId: meta.id, intent: "BUY_YES", qty: 150, priceCents: 58, fee: "0", usdc: null, signature: sig() },
    { time: h(60 * 26), marketId: seeded("mkt:TSLA:33500:prev"), intent: "BUY_YES", qty: 50, priceCents: 62, fee: "0", usdc: null, signature: sig() },
    { time: h(60 * 27), marketId: seeded("mkt:MSFT:52000:prev"), intent: "MINT", qty: 60, priceCents: null, fee: "0", usdc: "60000000", signature: sig() },
  ].filter((x) => x.qty > 0 || x.intent !== "BUY_NO"));
}

function addUserOrder(m: Mkt, side: "BID" | "ASK", price: number, owner: string, orderId: string, qty: number) {
  const book = side === "BID" ? m.bids : m.asks;
  const lvl = book.get(price) ?? { mm: 0, users: [] };
  lvl.users.push({ owner, orderId, qty });
  book.set(price, lvl);
}
const lvlQty = (l: Level) => l.mm + l.users.reduce((a, u) => a + u.qty, 0);
const snapshot = (m: Mkt) => ({
  seq: String(m.seq),
  bids: [...m.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, 20).map(([p, l]) => [p, lvlQty(l)] as [number, number]),
  asks: [...m.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, 20).map(([p, l]) => [p, lvlQty(l)] as [number, number]),
});
function bbo(m: Mkt) {
  const bid = m.bids.size ? Math.max(...m.bids.keys()) : null;
  const ask = m.asks.size ? Math.min(...m.asks.keys()) : null;
  return { bid, ask };
}

function viewStatus(m: Mkt) {
  if (m.status !== "TRADING") return m.status;
  const t = now();
  if (t >= day.close) return "HALTED";
  if (t < day.mintOpen) return "PRE_OPEN";
  if (t < day.open) return "MINT_ONLY";
  return "TRADING";
}

function marketJson(m: Mkt) {
  const { bid, ask } = bbo(m);
  const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
  const closeS = Math.floor((m.date === day.date ? day.close : Date.parse(`${m.date}T21:00:00Z`)) / 1000);
  return {
    marketId: m.id, symbol: m.symbol, tradingDate: m.date, strike: centsToDollars(m.strikeCents), strikeCents: m.strikeCents,
    question: question(m.symbol, m.strikeCents), status: viewStatus(m), outcome: m.outcome,
    yes: { bid, ask, last: m.last }, no: { bid: ask != null ? 100 - ask : null, ask: bid != null ? 100 - bid : null },
    impliedProbability: mid != null ? mid / 100 : m.last != null ? m.last / 100 : null,
    volume: m.volume, pairsOutstanding: m.pairs, yesMint: m.yesMint, noMint: m.noMint,
    openTime: iso(day.open), closeTime: iso(closeS * 1000), closeTimeUnix: closeS, seq: String(m.seq),
  };
}

function phase(): string {
  const t = now();
  if (t < day.mintOpen) return "PRE_OPEN";
  if (t < day.open) return "MINT_ONLY";
  if (t < day.close) return "TRADING";
  const today = [...markets.values()].filter((m) => m.date === day.date);
  if (today.every((m) => m.status === "SETTLED" || m.status === "VOID")) return "SETTLED";
  return settlement.size ? "SETTLING" : "HALTED";
}

function positionJson(owner: string, id: string, p: Pos) {
  const m = markets.get(id)!;
  const side = p.pendingNo > 0 ? "BOTH_PENDING" : p.yes > 0 && p.no > 0 ? "BOTH" : p.no > 0 ? "NO" : p.yes > 0 ? "YES" : "FLAT";
  const isNo = side === "NO" || side === "BOTH_PENDING";
  const qty = isNo ? p.no : p.yes;
  const cost = isNo ? p.noCost : side === "BOTH" ? p.yesCost + p.noCost : p.yesCost;
  const { bid, ask } = bbo(m);
  const yesMark = bid != null && ask != null ? (bid + ask) / 2 : m.last;
  let mark: number | null = yesMark == null ? null : isNo ? 100 - yesMark : yesMark;
  if (m.status === "SETTLED") mark = (m.outcome === "YES") !== isNo ? 100 : 0;
  if (m.status === "VOID") mark = 50;
  const value = side === "BOTH" ? BigInt(p.yes) * BigInt(Math.round((mark ?? 50) * 10_000)) + BigInt(p.no) * BigInt(Math.round((100 - (mark ?? 50)) * 10_000))
    : mark == null ? null : (BigInt(qty) * BigInt(Math.round(mark * 100)) * 10_000n) / 100n;
  const unreal = p.redeemed || value == null ? 0n : value - cost;
  const redeemable = p.redeemed ? 0n : m.status === "SETTLED" ? BigInt(m.outcome === "YES" ? p.yes : m.outcome === "NO" ? p.no : 0) * 1_000_000n : m.status === "VOID" ? BigInt(p.yes + p.no) * 500_000n : 0n;
  return {
    marketId: id, symbol: m.symbol, strike: centsToDollars(m.strikeCents), side, qty, yesQty: p.yes, noQty: p.no,
    avgEntryCents: qty > 0 ? Math.round((Number(cost) / qty / 10_000) * 100) / 100 : null,
    markCents: mark, unrealizedPnl: unreal.toString(), realizedPnl: p.realized.toString(), status: viewStatus(m), outcome: m.outcome,
    payoutIfWin: (BigInt(qty) * 1_000_000n).toString(), redeemable: redeemable.toString(), redeemed: p.redeemed,
    ledger: { freeUsdc: p.ledgerUsdc.toString(), freeYes: p.ledgerYes },
  };
}

// ---------- errors ----------
const HTTP: Record<string, number> = { NOT_SETTLED: 409, NOT_FOUND: 404, VALIDATION: 400, UNAUTHORIZED: 401, POSITION_CONFLICT: 409, MARKET_HALTED: 409, MARKET_NOT_OPEN: 409, PAUSED: 409, NO_LIQUIDITY: 409, INSUFFICIENT_BALANCE: 409, ORDER_TOO_LARGE: 422, RATE_LIMITED: 429 };
class Err extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

// ---------- transactions ----------
function buildTx(owner: string, op: Record<string, unknown>, summary: Record<string, unknown>, warnings: string[] = []) {
  const opId = randomBytes(12).toString("hex");
  pendingOps.set(opId, { ...op, owner });
  const msg = new TransactionMessage({
    payerKey: new PublicKey(owner),
    recentBlockhash: bs58.encode(randomBytes(32)),
    instructions: [new TransactionInstruction({ programId: STUB_PROGRAM, keys: [{ pubkey: new PublicKey(owner), isSigner: true, isWritable: true }], data: Buffer.from(opId, "utf8") })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  return { transaction: Buffer.from(tx.serialize()).toString("base64"), lastValidBlockHeight: blockHeight() + 150, summary, warnings };
}
const blockHeight = () => Math.floor(now() / 400) - 4_000_000_000;

function entryGuards(m: Mkt) {
  if (opts.paused) throw new Err("PAUSED", "Trading is paused");
  const s = viewStatus(m);
  if (s === "PRE_OPEN" || s === "MINT_ONLY") throw new Err("MARKET_NOT_OPEN", "The book is not open yet");
  if (s !== "TRADING") throw new Err("MARKET_HALTED", `Trading closed at ${iso(day.close)}`);
}

function txTrade(b: Record<string, unknown>) {
  const owner = String(b.owner ?? "");
  try {
    new PublicKey(owner);
  } catch {
    throw new Err("VALIDATION", "owner must be a base58 pubkey", { field: "owner" });
  }
  const m = markets.get(String(b.marketId));
  if (!m) throw new Err("NOT_FOUND", `Unknown market ${String(b.marketId)}`);
  const intent = b.intent as Intent;
  const type = b.orderType as "MARKET" | "LIMIT";
  const qty = Number(b.qty);
  const p = Number(b.priceCents);
  if (!["BUY_YES", "SELL_YES", "BUY_NO", "SELL_NO"].includes(intent)) throw new Err("VALIDATION", "bad intent", { field: "intent" });
  if (!Number.isInteger(qty) || qty < 1) throw new Err("VALIDATION", "qty must be a positive integer", { field: "qty" });
  if (!Number.isInteger(p) || p < 1 || p > 99) throw new Err("VALIDATION", "priceCents must be 1 to 99", { field: "priceCents" });
  if (qty > 500) throw new Err("ORDER_TOO_LARGE", "At most 500 contracts per trade; reduce the size or split the order", { maxQty: 500, qty });
  entryGuards(m);
  ensureUser(owner);
  const ps = pos(owner, m.id);
  const lockedAsk = (orders.get(owner) ?? []).filter((o) => o.marketId === m.id && o.bookSide === "ASK" && o.status === "OPEN" && o.intent === "SELL_YES").reduce((a, o) => a + o.qty - o.filled, 0);
  const conflict = (requiredAction: string, msg: string, extra: Record<string, unknown> = {}) => new Err("POSITION_CONFLICT", msg, { requiredAction, yes: ps.yes, no: ps.no, ...extra });
  if (intent === "BUY_YES" && ps.no > 0) throw conflict(ps.pendingNo > 0 ? "CANCEL_BUY_NO" : "SELL_NO", "Sell your No first");
  if (intent === "BUY_NO" && ps.yes - ps.pendingNo > 0) throw conflict("SELL_YES", "Sell your Yes first");
  if (intent === "SELL_NO" && qty > ps.no - ps.pendingNo) throw conflict("REDUCE_QTY", `You hold ${ps.no - ps.pendingNo} No`, { available: ps.no - ps.pendingNo });
  if (intent === "SELL_YES" && qty > ps.yes - lockedAsk) throw conflict("REDUCE_QTY", `You hold ${ps.yes - lockedAsk} Yes not already offered`, { available: ps.yes - lockedAsk });
  const isNo = intent === "BUY_NO" || intent === "SELL_NO";
  const yesPrice = isNo ? 100 - p : p;
  const takerBid = intent === "BUY_YES" || intent === "SELL_NO";
  const avail = [...(takerBid ? m.asks : m.bids).entries()].filter(([lp]) => (takerBid ? lp <= yesPrice : lp >= yesPrice)).reduce((a, [, l]) => a + l.mm, 0);
  const warnings: string[] = [];
  if (type === "MARKET") {
    if (avail === 0) throw new Err("NO_LIQUIDITY", `Nothing to ${takerBid ? "buy" : "sell"} into at ${p}¢ or better`, { worstPriceCents: p });
    if (avail < qty) warnings.push("PARTIAL_FILL_LIKELY");
  }
  if (ps.ledgerUsdc > 0n) warnings.push("LEDGER_WITHDRAW_BUNDLED");
  const notional = BigInt(qty) * BigInt(p) * 10_000n;
  const fee = takerFee(BigInt(qty) * BigInt(yesPrice) * 10_000n, opts.feeBps);
  const buying = intent.startsWith("BUY");
  const upfront = intent === "BUY_NO" && type !== "MARKET" ? BigInt(qty) * 1_000_000n : buying ? notional + fee : 0n;
  const bal = balances.get(owner) ?? 0n;
  if (upfront > 0n && bal + ps.ledgerUsdc < upfront) throw new Err("INSUFFICIENT_BALANCE", `This needs $${centsToDollars(upfront / 10_000n)} USDC in your wallet`, { required: upfront.toString(), available: bal.toString() });
  const summary = {
    intent, orderType: type, qty, worstPriceCents: p, yesPriceCents: yesPrice,
    maxCost: buying ? (notional + fee).toString() : "0", minProceeds: buying ? "0" : (notional - fee).toString(),
    payoutIfWin: buying ? (BigInt(qty) * 1_000_000n).toString() : "0", upfront: upfront.toString(), fee: fee.toString(),
    copy: summaryCopy(intent, m.symbol, BigInt(m.strikeCents), BigInt(qty), p, fee),
    instruction: intent === "BUY_NO" ? (type === "MARKET" ? "buy_no_market" : "buy_no_limit") : intent === "SELL_NO" && type === "MARKET" ? "sell_no" : "place_order",
  };
  return buildTx(owner, { kind: "trade", marketId: m.id, intent, type, qty, p, yesPrice }, summary, warnings);
}

/** Applies a confirmed trade: match the synthetic maker, rest a limit, update the user's position, publish. */
function applyTrade(owner: string, op: { marketId: string; intent: Intent; type: string; qty: number; p: number; yesPrice: number }, sig: string) {
  const m = markets.get(op.marketId)!;
  const ps = pos(owner, m.id);
  const takerBid = op.intent === "BUY_YES" || op.intent === "SELL_NO";
  const book = takerBid ? m.asks : m.bids;
  const prices = [...book.keys()].filter((lp) => (takerBid ? lp <= op.yesPrice : lp >= op.yesPrice)).sort((a, b) => (takerBid ? a - b : b - a));
  let left = op.qty;
  const changes: ["B" | "A", number, number][] = [];
  const prevSeq = m.seq;
  let spentMicro = 0n;
  const fills: { price: number; qty: number }[] = [];
  for (const lp of prices) {
    if (left === 0) break;
    const l = book.get(lp)!;
    const take = Math.min(left, l.mm);
    if (take === 0) continue;
    l.mm -= take;
    left -= take;
    fills.push({ price: lp, qty: take });
    spentMicro += BigInt(take) * BigInt(lp) * 10_000n;
    if (lvlQty(l) === 0) book.delete(lp);
    changes.push([takerBid ? "A" : "B", lp, book.has(lp) ? lvlQty(l) : 0]);
  }
  const filled = op.qty - left;
  const isNo = op.intent === "BUY_NO" || op.intent === "SELL_NO";
  const intentMicro = isNo ? BigInt(filled) * 1_000_000n - spentMicro : spentMicro; // what the user paid/received in intent terms
  let bal = (balances.get(owner) ?? 0n) + ps.ledgerUsdc;
  ps.ledgerUsdc = 0n;
  switch (op.intent) {
    case "BUY_YES": ps.yes += filled; ps.yesCost += intentMicro; bal -= intentMicro; break;
    case "BUY_NO": ps.no += filled; ps.noCost += intentMicro; bal -= intentMicro; break;
    case "SELL_YES": {
      const basis = ps.yes > 0 ? (ps.yesCost * BigInt(filled)) / BigInt(ps.yes) : 0n;
      ps.yes -= filled; ps.yesCost -= basis; ps.realized += intentMicro - basis; bal += intentMicro; break;
    }
    case "SELL_NO": {
      const basis = ps.no > 0 ? (ps.noCost * BigInt(filled)) / BigInt(ps.no) : 0n;
      ps.no -= filled; ps.noCost -= basis; ps.realized += intentMicro - basis; bal += intentMicro; break;
    }
  }
  if (filled > 0) {
    m.last = fills.at(-1)!.price;
    m.volume += filled;
  }
  // A limit rests the remainder (a Buy No limit mints pairs and offers the Yes: pending, A10).
  const list = orders.get(owner) ?? [];
  if (op.type === "LIMIT" && left > 0) {
    const side = op.intent === "BUY_YES" || op.intent === "SELL_NO" ? "BID" : "ASK";
    const oid = String(nextOrderId++);
    addUserOrder(m, side, op.yesPrice, owner, oid, left);
    const lvl = (side === "BID" ? m.bids : m.asks).get(op.yesPrice)!;
    changes.push([side === "BID" ? "B" : "A", op.yesPrice, lvlQty(lvl)]);
    list.push({ marketId: m.id, orderId: oid, intent: op.intent, bookSide: side, yesPriceCents: op.yesPrice, priceCents: op.p, qty: op.qty, filled, tif: "GTC", status: "OPEN", placedAt: iso(now()), signature: sig });
    if (op.intent === "BUY_NO") {
      ps.yes += left; ps.no += left; ps.pendingNo += left;
      ps.noCost += BigInt(left) * BigInt(op.p) * 10_000n;
      bal -= BigInt(left) * 1_000_000n;
    }
    publish_(`user:${owner}`, { type: "order", market: m.id, order_id: oid, status: "OPEN", qty: left });
  }
  orders.set(owner, list);
  balances.set(owner, bal);
  if (filled > 0) {
    const h = history.get(owner) ?? [];
    const avgYes = Number(spentMicro / BigInt(filled) / 10_000n);
    h.unshift({ time: iso(now()), marketId: m.id, intent: op.intent, qty: filled, priceCents: isNo ? 100 - avgYes : avgYes, fee: "0", usdc: null, signature: sig });
    history.set(owner, h);
  }
  if (changes.length) {
    m.seq += 1;
    publish_(`book:${m.id}`, { type: "book_delta", seq: String(m.seq), prev_seq: String(prevSeq), changes });
  }
  for (const f of fills) {
    publish_(`trades:${m.id}`, { type: "trade", seq: String(m.seq), price: f.price, qty: f.qty, taker_side: takerBid ? "BID" : "ASK", ts: Math.floor(now() / 1000) });
    publish_(`user:${owner}`, { type: "fill", market: m.id, seq: String(m.seq), price: f.price, qty: f.qty, intent: op.intent, sig });
  }
  publish_(`user:${owner}`, { type: "position", market: m.id });
  publish_(`user:${owner}`, { type: "balance", usdc: bal.toString() });
}

function applyCancel(owner: string, op: { marketId: string; orderId?: string; all?: boolean }) {
  const m = markets.get(op.marketId)!;
  const list = orders.get(owner) ?? [];
  const ps = pos(owner, m.id);
  const changes: ["B" | "A", number, number][] = [];
  const prevSeq = m.seq;
  for (const o of list) {
    if (o.marketId !== m.id || o.status !== "OPEN" || (!op.all && o.orderId !== op.orderId)) continue;
    o.status = "CANCELLED";
    const book = o.bookSide === "BID" ? m.bids : m.asks;
    const l = book.get(o.yesPriceCents);
    if (l) {
      const rest = l.users.find((u) => u.orderId === o.orderId)?.qty ?? 0;
      l.users = l.users.filter((u) => u.orderId !== o.orderId);
      if (lvlQty(l) === 0) book.delete(o.yesPriceCents);
      changes.push([o.bookSide === "BID" ? "B" : "A", o.yesPriceCents, book.has(o.yesPriceCents) ? lvlQty(l) : 0]);
      if (o.intent === "BUY_NO") {
        ps.yes -= rest; ps.no -= rest; ps.pendingNo -= rest;
        ps.noCost -= BigInt(rest) * BigInt(o.priceCents) * 10_000n;
        balances.set(owner, (balances.get(owner) ?? 0n) + BigInt(rest) * 1_000_000n);
      }
    }
    publish_(`user:${owner}`, { type: "order", market: m.id, order_id: o.orderId, status: "CANCELLED", qty: 0 });
  }
  if (changes.length) {
    m.seq += 1;
    publish_(`book:${m.id}`, { type: "book_delta", seq: String(m.seq), prev_seq: String(prevSeq), changes });
  }
  publish_(`user:${owner}`, { type: "position", market: m.id });
}

function applyOp(op: Record<string, unknown>, sig: string) {
  const owner = String(op.owner);
  switch (op.kind) {
    case "trade": return applyTrade(owner, op as never, sig);
    case "cancel": return applyCancel(owner, op as never);
    case "withdraw": {
      const p = pos(owner, String(op.marketId));
      balances.set(owner, (balances.get(owner) ?? 0n) + p.ledgerUsdc);
      p.ledgerUsdc = 0n;
      p.ledgerYes = 0;
      publish_(`user:${owner}`, { type: "position", market: op.marketId });
      return publish_(`user:${owner}`, { type: "balance", usdc: (balances.get(owner) ?? 0n).toString() });
    }
    case "redeem": {
      let total = 0n;
      for (const id of op.marketIds as string[]) {
        const p = pos(owner, id);
        const r = BigInt(positionJson(owner, id, p).redeemable);
        p.redeemed = true; // winners pay out, losers are burned for $0.00
        if (r > 0n) {
          total += r;
          const h = history.get(owner) ?? [];
          h.unshift({ time: iso(now()), marketId: id, intent: "REDEEM", qty: Number(r / 1_000_000n), priceCents: null, fee: "0", usdc: r.toString(), signature: sig });
          history.set(owner, h);
        }
        publish_(`user:${owner}`, { type: "position", market: id });
      }
      balances.set(owner, (balances.get(owner) ?? 0n) + total);
      return publish_(`user:${owner}`, { type: "balance", usdc: (balances.get(owner) ?? 0n).toString() });
    }
  }
}

// ---------- websocket gateway ----------
interface Conn { ws: WebSocket; subs: Set<string>; owner: string | null }
const conns = new Set<Conn>();
function publish_(channel: string, msg: Record<string, unknown>) {
  for (const c of conns) {
    const name = channel.startsWith("user:") ? (c.owner && channel === `user:${c.owner}` ? "user" : null) : channel;
    if (name && c.subs.has(name)) c.ws.send(JSON.stringify({ ...msg, channel: name }));
  }
}
function onWs(c: Conn, raw: string) {
  let m: { op?: string; channels?: string[]; channel?: string; token?: string };
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  const send = (o: object) => c.ws.send(JSON.stringify(o));
  if (m.op === "ping") return send({ type: "pong", serverTime: iso(now()) });
  if (m.op === "auth") {
    const r = m.token ? verifyJwt(m.token, JWT_SECRET, Math.floor(now() / 1000)) : null;
    if (!r || !r.ok) return send({ type: "error", code: "UNAUTHORIZED", message: "invalid or expired token" });
    c.owner = r.claims.sub;
    send({ type: "auth_ok", owner: c.owner });
    return;
  }
  if (m.op === "snapshot" && m.channel?.startsWith("book:")) {
    const mk = markets.get(m.channel.slice(5));
    if (mk) send({ type: "book_snapshot", channel: m.channel, ...snapshot(mk) });
    return;
  }
  for (const ch of m.channels ?? []) {
    if (m.op === "unsubscribe") {
      c.subs.delete(ch);
      continue;
    }
    if (ch === "user" && !c.owner) {
      send({ type: "error", code: "UNAUTHORIZED", message: "send auth before subscribing to user", channel: "user" });
      continue;
    }
    c.subs.add(ch);
    send({ type: "subscribed", channel: ch });
    if (ch.startsWith("book:")) {
      const mk = markets.get(ch.slice(5));
      if (mk) send({ type: "book_snapshot", channel: ch, ...snapshot(mk) });
    }
  }
}

// ---------- live activity ----------
let tick = 0;
function liveTick(force = false) {
  if (!opts.live && !force) return;
  tick++;
  for (const [sym, p] of px) {
    const r = Math.random();
    p.price = Math.round(p.price * (1 + (r - 0.5) * 0.0008) * 100) / 100;
    p.t = now();
    publish_(`px:${sym}`, { type: "underlying", price: p.price.toFixed(2), conf: (p.price * 0.0001).toFixed(2), publish_time: Math.floor(p.t / 1000) });
  }
  if (phase() !== "TRADING") return;
  const all = [...markets.values()].filter((m) => m.status === "TRADING" && m.date === day.date);
  for (let k = 0; k < (force ? 1 : 3); k++) {
    const m = all[Math.floor(Math.random() * all.length)]!;
    const side = Math.random() < 0.5 ? "B" : "A";
    const book = side === "B" ? m.bids : m.asks;
    const keys = [...book.keys()].sort((a, b) => (side === "B" ? b - a : a - b)).slice(0, 4);
    const lp = keys[Math.floor(Math.random() * keys.length)];
    if (lp === undefined) continue;
    const l = book.get(lp)!;
    l.mm = Math.max(50, l.mm + Math.round((Math.random() - 0.45) * 300));
    const prev = m.seq;
    m.seq += 1;
    publish_(`book:${m.id}`, { type: "book_delta", seq: String(m.seq), prev_seq: String(prev), changes: [[side, lp, lvlQty(l)]] });
  }
}

// ---------- http ----------
function cors(res: ServerResponse) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, authorization, solana-client");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
}
function json(res: ServerResponse, status: number, body: unknown) {
  cors(res);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function user(req: IncomingMessage): string {
  const h = req.headers.authorization ?? "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  const r = t ? verifyJwt(t, JWT_SECRET, Math.floor(now() / 1000)) : null;
  if (!r || !r.ok) throw new Err("UNAUTHORIZED", "Sign in again");
  ensureUser(r.claims.sub);
  return r.claims.sub;
}

async function rpc(body: { id: unknown; method: string; params?: unknown[] }) {
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: body.id, result });
  const ctx = { slot: Math.floor(now() / 400) };
  switch (body.method) {
    case "getGenesisHash": return ok(DEVNET_GENESIS);
    case "getBlockHeight": return ok(blockHeight());
    case "getSlot": return ok(ctx.slot);
    case "getLatestBlockhash": return ok({ context: ctx, value: { blockhash: bs58.encode(randomBytes(32)), lastValidBlockHeight: blockHeight() + 150 } });
    case "getTokenAccountsByOwner": {
      const owner = String(body.params?.[0]);
      ensureUser(owner);
      const amount = (balances.get(owner) ?? 0n).toString();
      return ok({ context: ctx, value: [{ pubkey: seeded(`ata:${owner}`), account: { lamports: 2039280, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", executable: false, rentEpoch: 0, space: 165,
        data: { program: "spl-token", parsed: { type: "account", info: { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", owner, state: "initialized", tokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: (Number(amount) / 1e6).toString() } } }, space: 165 } } }] });
    }
    case "sendTransaction": {
      const raw = Buffer.from(String(body.params?.[0]), (body.params?.[1] as { encoding?: string } | undefined)?.encoding === "base58" ? "utf8" : "base64");
      const tx = VersionedTransaction.deserialize(raw);
      const payer = tx.message.staticAccountKeys[0]!;
      const sigBytes = tx.signatures[0]!;
      if (!nacl.sign.detached.verify(tx.message.serialize(), sigBytes, payer.toBytes())) {
        rejectedSigs++;
        return { jsonrpc: "2.0", id: body.id, error: { code: -32003, message: "Transaction signature verification failure" } };
      }
      const opId = Buffer.from(tx.message.compiledInstructions[0]!.data).toString("utf8");
      const op = pendingOps.get(opId);
      const sig = bs58.encode(sigBytes);
      if (!op) return { jsonrpc: "2.0", id: body.id, error: { code: -32002, message: "Transaction simulation failed: Blockhash not found" } };
      pendingOps.delete(opId);
      const err = failNext ? { InstructionError: [0, { Custom: Number(failNext) || 6000 }] } : null;
      failNext = null;
      sigs.set(sig, { at: Date.now() + 350, err });
      if (!err) setTimeout(() => applyOp(op, sig), 300);
      return ok(sig);
    }
    case "getSignatureStatuses": {
      const list = (body.params?.[0] as string[]) ?? [];
      return ok({ context: ctx, value: list.map((s) => {
        const x = sigs.get(s);
        if (!x || Date.now() < x.at) return null;
        return { slot: ctx.slot, confirmations: null, err: x.err, confirmationStatus: "confirmed", status: x.err ? { Err: x.err } : { Ok: null } };
      }) });
    }
    default: return { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `stub RPC does not implement ${body.method}` } };
  }
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://stub");
  const path = url.pathname.replace(/\/$/, "");
  const q = (k: string) => url.searchParams.get(k) ?? undefined;
  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    return res.end();
  }
  try {
    if (path === "/rpc" && req.method === "POST") {
      const b = await readBody(req);
      return json(res, 200, Array.isArray(b) ? await Promise.all(b.map((x) => rpc(x as never))) : await rpc(b as never));
    }
    // ---- test controls ----
    if (path === "/__stub/reset") return (reset(await readBody(req)), json(res, 200, { ok: true, day, serverTime: iso(now()) }));
    if (path === "/__stub/state") return json(res, 200, { opts, day, serverTime: iso(now()), rejectedSigs, markets: [...markets.values()].map((m) => ({ id: m.id, symbol: m.symbol, strikeCents: m.strikeCents, status: m.status })) });
    if (path === "/__stub/pause") {
      opts.paused = !!(await readBody(req)).paused;
      publish_("sys", { type: opts.paused ? "paused" : "unpaused", by: "stub" });
      return json(res, 200, { paused: opts.paused });
    }
    if (path === "/__stub/settle") {
      const b = await readBody(req);
      const m = markets.get(String(b.marketId));
      if (!m) throw new Err("NOT_FOUND", "unknown market");
      if (b.outcome) {
        m.status = "SETTLED";
        m.outcome = b.outcome as "YES" | "NO";
        publish_(`market:${m.id}`, { type: "market_status", status: "SETTLED", outcome: m.outcome, seq: String(m.seq) });
      } else settleMarket(m);
      return json(res, 200, marketJson(m));
    }
    if (path === "/__stub/fail-next-tx") return (failNext = String((await readBody(req)).code ?? "6012"), json(res, 200, { ok: true }));
    if (path === "/__stub/tick") return (liveTick(true), json(res, 200, { ok: true }));
    if (path === "/__stub/px") {
      const b = await readBody(req);
      const p = px.get(String(b.symbol))!;
      p.price = Number(b.price);
      publish_(`px:${b.symbol}`, { type: "underlying", price: p.price.toFixed(2), conf: "0.05", publish_time: Math.floor(now() / 1000) });
      return json(res, 200, { ok: true });
    }
    if (path === "/__stub/delta") {
      // Publish a raw book delta (e.g. with a wrong prev_seq to exercise the client's gap handling).
      const b = await readBody(req);
      publish_(`book:${b.marketId}`, b.delta as Record<string, unknown>);
      return json(res, 200, { ok: true });
    }

    // ---- REST API (spec 7.1 to 7.3) ----
    if (path === "/v1/health") return json(res, 200, { ok: true, slot: Math.floor(now() / 400), indexerLagMs: 40, serverTime: iso(now()) });
    if (path === "/v1/status") {
      return json(res, 200, { paused: opts.paused, slot: Math.floor(now() / 400), tradingDate: day.date, phase: phase(), openTime: iso(day.open), closeTime: iso(day.close), closeTimeUnix: Math.floor(day.close / 1000), serverTime: new Date(now()).toISOString() });
    }
    if (path === "/v1/tickers") {
      return json(res, 200, { data: TICKERS.map(([s]) => {
        const p = px.get(s)!;
        return { symbol: s, underlying: { price: p.price.toFixed(2), conf: (p.price * 0.0001).toFixed(2), publishTime: iso(p.t) }, prevClose: p.prev.toFixed(2), activeMarkets: mktsFor(s).filter((m) => m.date === day.date && viewStatus(m) === "TRADING").length, tickerDayStatus: settlement.has(s) ? "FINAL" : "OPEN" };
      }) });
    }
    let mm = /^\/v1\/tickers\/([A-Z]+)\/markets$/.exec(path);
    if (mm) {
      const sym = mm[1]!;
      if (!TICKERS.some(([s]) => s === sym)) throw new Err("NOT_FOUND", `Unknown ticker ${sym}`);
      const date = q("date") ?? day.date;
      return json(res, 200, { symbol: sym, tradingDate: date, closeTime: iso(day.close), closeTimeUnix: Math.floor(day.close / 1000), markets: mktsFor(sym).filter((m) => m.date === date).map(marketJson) });
    }
    mm = /^\/v1\/markets\/([^/]+)(\/book|\/trades)?$/.exec(path);
    if (mm) {
      const m = markets.get(mm[1]!);
      if (!m) throw new Err("NOT_FOUND", `Unknown market ${mm[1]}`);
      if (mm[2] === "/book") {
        const s = snapshot(m);
        const view = (q("view") ?? "YES").toUpperCase();
        const lv = view === "NO" ? noView(s.bids, s.asks) : s;
        return json(res, 200, { marketId: m.id, seq: s.seq, view, bids: lv.bids, asks: lv.asks, updatedAt: iso(now()) });
      }
      if (mm[2] === "/trades") {
        const r = rng(m.strikeCents);
        const data = Array.from({ length: 12 }, (_, i) => {
          const p = Math.max(1, Math.min(99, (m.last ?? 50) + Math.round((r() - 0.5) * 4)));
          return { seq: String(m.seq - i), priceCents: p, noPriceCents: 100 - p, qty: Math.floor(5 + r() * 120), takerSide: r() > 0.5 ? "BID" : "ASK", time: iso(now() - (i * 97 + 30) * 1000), signature: bs58.encode(createHash("sha512").update(`${m.id}${i}`).digest()) };
        });
        return json(res, 200, { marketId: m.id, data, nextBefore: null });
      }
      const set = settlement.get(m.symbol);
      return json(res, 200, { ...marketJson(m), outcomeProvisional: false, settlePrice: m.status === "SETTLED" ? set?.closePrice ?? null : null });
    }
    if (path === "/v1/settlements") {
      const date = q("date") ?? day.date;
      const tickers = TICKERS.map(([s]) => {
        const ms = mktsFor(s).filter((m) => m.date === date);
        if (!ms.length) return null;
        const settledHere = ms.some((m) => m.status === "SETTLED");
        const close = date === day.date ? settlement.get(s)?.closePrice ?? null : s === "TSLA" ? "341.27" : s === "MSFT" ? "523.64" : null;
        return { symbol: s, status: settledHere ? "FINAL" : "OPEN", closePrice: close, publishTime: close ? iso(day.close) : null, finalAt: null,
          markets: ms.map((m) => ({ marketId: m.id, strike: centsToDollars(m.strikeCents), strikeCents: m.strikeCents, outcome: m.outcome, provisional: false, status: m.status })) };
      }).filter(Boolean);
      return json(res, 200, { tradingDate: date, tickers });
    }
    if (path === "/v1/auth/siws/nonce") {
      const b = await readBody(req);
      const owner = String(b.owner ?? "");
      const nonce = randomBytes(16).toString("hex");
      const t = Math.floor(now() / 1000);
      const message = siwsMessage({ domain: DOMAIN, owner, nonce, issuedAt: iso(t * 1000), expirationTime: iso((t + 300) * 1000) });
      nonces.set(nonce, { owner, message, exp: t + 300 });
      return json(res, 200, { nonce, message, expiresAt: iso((t + 300) * 1000) });
    }
    if (path === "/v1/auth/siws/verify") {
      const b = await readBody(req) as { owner: string; signature: string; message: string };
      const n = /\nNonce: ([0-9a-f]{32})\n/.exec(b.message ?? "")?.[1];
      const s = n ? nonces.get(n) : undefined;
      if (n) nonces.delete(n);
      if (!s || s.owner !== b.owner || s.message !== b.message) throw new Err("UNAUTHORIZED", "Nonce unknown, used or expired");
      if (!verifyEd25519(b.owner, b.message, b.signature)) throw new Err("UNAUTHORIZED", "Bad signature");
      const t = Math.floor(now() / 1000);
      const ttl = Number(process.env.STUB_JWT_TTL ?? 900);
      return json(res, 200, { token: signJwt({ sub: b.owner, iat: t, exp: t + ttl }, JWT_SECRET), expiresAt: iso((t + ttl) * 1000), admin: false });
    }
    if (path === "/v1/me/positions") {
      const owner = user(req);
      const status = (q("status") ?? "OPEN").toUpperCase();
      const data = [...(positions.get(owner) ?? new Map()).entries()].map(([id, p]) => ({ p, j: positionJson(owner, id, p) })).filter(({ p, j }) => {
        const settled = j.status === "SETTLED" || j.status === "VOID";
        if (status === "OPEN" && settled) return false;
        if (status === "SETTLED" && !settled) return false;
        return !(p.yes === 0 && p.no === 0 && p.ledgerUsdc === 0n && p.realized === 0n);
      }).map(({ j }) => j);
      return json(res, 200, { data });
    }
    if (path === "/v1/me/orders") {
      const owner = user(req);
      const status = (q("status") ?? "OPEN").toUpperCase();
      const mid = q("marketId");
      const data = (orders.get(owner) ?? []).filter((o) => (status === "ALL" || o.status === "OPEN") && (!mid || o.marketId === mid)).map((o) => ({ ...o, remaining: o.qty - o.filled }));
      return json(res, 200, { data });
    }
    if (path === "/v1/me/history") {
      const owner = user(req);
      const data = (history.get(owner) ?? []).slice(0, Number(q("limit") ?? 50));
      return json(res, 200, { data, nextBefore: null });
    }
    if (path === "/v1/me/claimable") {
      const owner = user(req);
      let lt = 0n;
      let rt = 0n;
      const data = [];
      for (const [id, p] of positions.get(owner) ?? []) {
        const j = positionJson(owner, id, p);
        const red = BigInt(j.redeemable);
        if (p.ledgerUsdc === 0n && p.ledgerYes === 0 && red === 0n) continue;
        lt += p.ledgerUsdc;
        rt += red;
        data.push({ marketId: id, symbol: j.symbol, strike: j.strike, status: markets.get(id)!.status, ledger: j.ledger, redeemable: j.redeemable });
      }
      return json(res, 200, { data, totals: { ledgerUsdc: lt.toString(), redeemable: rt.toString() } });
    }
    if (path === "/v1/me/prefs") {
      const owner = user(req);
      if (req.method === "PUT") {
        const b = await readBody(req);
        const cur = prefs.get(owner)!;
        if (b.defaultView !== undefined && b.defaultView !== "YES" && b.defaultView !== "NO") throw new Err("VALIDATION", "defaultView must be YES or NO", { field: "defaultView" });
        prefs.set(owner, { defaultView: (b.defaultView as "YES" | "NO") ?? cur.defaultView, slippageCents: (b.slippageCents as number) ?? cur.slippageCents });
      }
      return json(res, 200, prefs.get(owner));
    }

    // ---- Tx Builder (spec 7.4) ----
    if (path === "/v1/tx/trade") return json(res, 200, txTrade(await readBody(req)));
    if (path === "/v1/tx/cancel") {
      const b = await readBody(req);
      const m = markets.get(String(b.marketId));
      if (!m) throw new Err("NOT_FOUND", "Unknown market");
      return json(res, 200, buildTx(String(b.owner), { kind: "cancel", marketId: m.id, orderId: b.orderId, all: b.all }, { action: "CANCEL", copy: b.all ? "Cancel all your orders on this contract." : "Cancel this order." }));
    }
    if (path === "/v1/tx/withdraw") {
      const b = await readBody(req);
      const p = pos(String(b.owner), String(b.marketId));
      return json(res, 200, buildTx(String(b.owner), { kind: "withdraw", marketId: b.marketId }, { action: "WITHDRAW", amount: p.ledgerUsdc.toString(), copy: `Withdraw $${centsToDollars(p.ledgerUsdc / 10_000n)} to your wallet.` }));
    }
    if (path === "/v1/tx/redeem") {
      // Like the real builder: up to 50 markets, packed into as many transactions as needed
      // (the stub packs 6 a transaction), all of them returned in `transactions`.
      const b = await readBody(req);
      const owner = String(b.owner);
      const ids = [...new Set((b.marketIds as string[]) ?? [])];
      if (ids.length === 0 || ids.length > 50) throw new Err("VALIDATION", "marketIds must list 1 to 50 markets", { field: "marketIds" });
      for (const id of ids) {
        const st = markets.get(id)?.status;
        if (st !== "SETTLED" && st !== "VOID") throw new Err("NOT_SETTLED", `Market ${id} has not settled yet`, { marketId: id });
      }
      const held = ids.filter((id) => {
        const p = pos(owner, id);
        return !p.redeemed && (p.yes > 0 || p.no > 0);
      });
      if (held.length === 0) throw new Err("NOT_FOUND", "Nothing to redeem in these markets");
      const total = held.reduce((a, id) => a + BigInt(positionJson(owner, id, pos(owner, id)).redeemable), 0n);
      const txs: string[] = [];
      for (let i = 0; i < held.length; i += 6) txs.push(buildTx(owner, { kind: "redeem", marketIds: held.slice(i, i + 6) }, {}).transaction);
      const summary = { action: "REDEEM", markets: held.length, payout: total.toString(), transactions: txs.length, copy: `You receive $${centsToDollars(total / 10_000n)}.` };
      return json(res, 200, { transaction: txs[0], transactions: txs, lastValidBlockHeight: blockHeight() + 150, summary, warnings: txs.length > 1 ? ["SPLIT_INTO_MULTIPLE_TXS"] : [] });
    }
    throw new Err("NOT_FOUND", `No route ${req.method} ${path}`);
  } catch (e) {
    if (e instanceof Err) return json(res, HTTP[e.code] ?? 400, { error: { code: e.code, message: e.message, details: e.details } });
    console.error(e);
    return json(res, 500, { error: { code: "INTERNAL", message: (e as Error).message, details: {} } });
  }
}

reset();
const server = createServer((req, res) => void route(req, res));
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, sock, head) => {
  if (!req.url?.startsWith("/v1/ws")) return sock.destroy();
  wss.handleUpgrade(req, sock, head, (ws) => {
    const c: Conn = { ws, subs: new Set(), owner: null };
    conns.add(c);
    ws.on("message", (d) => onWs(c, d.toString()));
    ws.on("close", () => conns.delete(c));
  });
});
setInterval(() => liveTick(), 1500);
setInterval(() => {
  for (const c of conns) c.ws.send(JSON.stringify({ type: "heartbeat", serverTime: iso(now()) }));
}, 15_000);
server.listen(PORT, () => console.log(`meridian stub on http://localhost:${PORT} (REST, Tx Builder, WS /v1/ws, RPC /rpc)`));
