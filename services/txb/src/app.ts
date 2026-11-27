/**
 * Tx Builder (component C3, spec 7.4, MER-62, MER-63). Maps a user's intent to the exact
 * Meridian instruction and returns an **unsigned** v0 transaction with a recent blockhash
 * and the owner as fee payer. It never signs and holds no keys (decision 2).
 *
 * Inputs come from Redis at `confirmed` (R6.6): the market, the book's resting orders
 * (`md:book:{m}:ord`, for makers' ledgers and the liquidity check), the owner's position
 * (`md:pos`) and open orders (`md:oo`), the config (`md:cfg`: pause flag, fee, the 500
 * per-trade cap) and, when known, the wallet USDC balance (`md:bal`).
 */
import {
  AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import Fastify, { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { createHash, randomBytes } from "node:crypto";
import { isPubkey } from "../../shared/src/base58.js";
import { ApiError } from "../../shared/src/http.js";
import { K } from "../../shared/src/keys.js";
import { Intent, isoToKey, keyToIso, marketStatus, microToDollars, summaryCopy, takerFee } from "../../shared/src/market.js";
import {
  ixBuyNoLimit, ixBuyNoMarket, ixCancelAll, ixCancelOrder, ixCreateAtaIdempotent, ixMerge, ixMint, ixPlaceOrder, ixRaiseDispute, ixRedeem,
  ixSellNo, ixWithdraw, MarketKeys, Side,
} from "./chain/ixs.js";
import { seeded } from "./chain/pdas.js";
import type { AltSource, BlockhashSource } from "./sources.js";

export interface TxbDeps {
  redis: Redis;
  blockhash: BlockhashSource;
  alts: AltSource;
  usdcMint: PublicKey;
  bondVault: PublicKey;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** D8 bond, shown in the dispute summary. */
  disputeBondMicro?: bigint;
  logger?: boolean;
}

export const MAX_TX_BYTES = 1232;
const INTENTS = ["BUY_YES", "SELL_YES", "BUY_NO", "SELL_NO"] as const;
const ORDER_TYPES = ["MARKET", "LIMIT", "POST_ONLY"] as const;

interface Market extends MarketKeys {
  id: string;
  symbol: string;
  date: number;
  strikeCents: bigint;
  status: string;
  openTime: number;
  closeTime: number;
  mintOpenTime: number;
}

interface Position {
  yes: bigint;
  no: bigint;
  ledgerUsdc: bigint;
  ledgerYes: bigint;
  pendingNo: bigint;
}

interface RestingOrder {
  id: bigint;
  owner: string;
  side: Side;
  price: number;
  qty: bigint;
}

interface Cfg {
  paused: boolean;
  feeBps: number;
  maxQty: number;
}

type Body = Record<string, unknown>;

const big = (v: unknown) => BigInt(String(v ?? "0"));

export async function buildTxb(deps: TxbDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: true, bodyLimit: 16 * 1024 });
  const now = deps.now ?? (() => Date.now());
  const nowS = () => Math.floor(now() / 1000);
  const redis = deps.redis;

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send(err.body());
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode === 413 ? 413 : 400).send(new ApiError("VALIDATION", err.message).body());
    }
    app.log.error(err);
    return reply.status(500).send(new ApiError("INTERNAL", "Internal error").body());
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send(new ApiError("NOT_FOUND", "No such route").body()));

  // ---- input validation (SEC-08: every bad body is a 4xx with a code, never a 5xx) ----
  const body = (b: unknown): Body => {
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new ApiError("VALIDATION", "body must be a JSON object");
    return b as Body;
  };
  const owner = (b: Body): PublicKey => {
    if (!isPubkey(b.owner)) throw new ApiError("VALIDATION", "owner must be a base58 pubkey", { field: "owner" });
    return new PublicKey(b.owner);
  };
  const posInt = (b: Body, f: string, max = 1_000_000): bigint => {
    const v = b[f];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) throw new ApiError("VALIDATION", `${f} must be an integer from 1 to ${max}`, { field: f });
    return BigInt(v);
  };
  const cents = (b: Body, f: string): number => {
    const v = b[f];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 99) throw new ApiError("VALIDATION", `${f} must be an integer from 1 to 99`, { field: f });
    return v;
  };

  // ---- Redis reads ----
  async function cfg(): Promise<Cfg> {
    const h = await redis.hgetall(K.cfg);
    return { paused: h.paused === "1", feeBps: Number(h.fee_bps ?? 0), maxQty: Number(h.max_qty_per_trade ?? 500) };
  }

  async function market(b: Body): Promise<Market> {
    const id = b.marketId;
    if (!isPubkey(id)) throw new ApiError("VALIDATION", "marketId must be a market address", { field: "marketId" });
    const h = await redis.hgetall(K.mkt(id));
    if (!h.symbol) throw new ApiError("NOT_FOUND", `Unknown market ${id}`);
    const td = await redis.hmget(K.tday(h.symbol, h.date!), "mint_open_time", "open_time", "close_time");
    if (!h.book) h.book = seeded("book", new PublicKey(id)).toBase58(); // closed books still need an address for cancel/withdraw
    return {
      id, address: new PublicKey(id), symbol: h.symbol, date: Number(h.date), strikeCents: big(h.strike_cents), status: h.status ?? "TRADING",
      tickerDay: new PublicKey(h.ticker_day!), yesMint: new PublicKey(h.yes_mint!), noMint: new PublicKey(h.no_mint!),
      vault: new PublicKey(h.vault!), book: new PublicKey(h.book),
      openTime: Number(h.open_time || td[1] || 0), closeTime: Number(h.close_time || td[2] || 0), mintOpenTime: Number(td[0] || 0),
    };
  }

  async function position(o: PublicKey, m: Market): Promise<{ pos: Position; open: (RestingOrder & { tag: string })[] }> {
    const [p, oo] = await Promise.all([redis.hget(K.pos(o.toBase58()), m.id), redis.hgetall(K.oo(o.toBase58()))]);
    const j = p ? (JSON.parse(p) as Record<string, string | number>) : {};
    const open = Object.entries(oo)
      .filter(([k]) => k.startsWith(`${m.id}:`))
      .map(([, v]) => JSON.parse(v) as { order_id: string; side: Side; price: number; qty: number; tag: string; owner: string })
      .map((x) => ({ id: big(x.order_id), owner: x.owner, side: x.side, price: x.price, qty: BigInt(x.qty), tag: x.tag }));
    return {
      pos: { yes: big(j.yes), no: big(j.no), ledgerUsdc: big(j.ledger_usdc), ledgerYes: big(j.ledger_yes), pendingNo: big(j.pending_no) },
      open,
    };
  }

  async function book(m: Market): Promise<RestingOrder[]> {
    const h = await redis.hgetall(K.ord(m.id));
    return Object.entries(h).map(([id, v]) => {
      const x = JSON.parse(v) as { owner: string; side: Side; price: number; qty: number };
      return { id: BigInt(id), owner: x.owner, side: x.side, price: x.price, qty: BigInt(x.qty) };
    });
  }

  // ---- state guards ----
  function entryGuards(m: Market, c: Cfg, kind: "trade" | "mint") {
    if (c.paused) throw new ApiError("PAUSED", "Meridian is paused: new orders and mints are off; cancel, merge, withdraw and redeem still work");
    const s = marketStatus(m.status, nowS(), { mintOpenTime: m.mintOpenTime, openTime: m.openTime, closeTime: m.closeTime });
    if (s === "SETTLED" || s === "VOID" || s === "HALTED") throw new ApiError("MARKET_HALTED", `Trading closed${m.closeTime ? ` at ${new Date(m.closeTime * 1000).toISOString()}` : ""}`, { status: s });
    if (s === "PRE_OPEN" || (kind === "trade" && s === "MINT_ONLY")) {
      const at = kind === "trade" ? m.openTime : m.mintOpenTime;
      throw new ApiError("MARKET_NOT_OPEN", `${kind === "trade" ? "Trading" : "Minting"} opens at ${new Date(at * 1000).toISOString()}`, { opensAt: at });
    }
  }

  // ---- transaction assembly ----
  function compile(payer: PublicKey, ixs: TransactionInstruction[], alt: AddressLookupTableAccount | null): { tx: VersionedTransaction; size: number } {
    const bh = deps.blockhash.get();
    if (!bh) throw new ApiError("UNAVAILABLE", "No recent blockhash; try again shortly");
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message(alt ? [alt] : []);
    const tx = new VersionedTransaction(msg);
    try {
      return { tx, size: tx.serialize().length };
    } catch {
      return { tx, size: Number.POSITIVE_INFINITY }; // web3.js refuses to serialize past the packet size
    }
  }

  function respond(tx: VersionedTransaction, summary: Record<string, unknown>, warnings: string[]) {
    return {
      transaction: Buffer.from(tx.serialize()).toString("base64"),
      lastValidBlockHeight: deps.blockhash.get()!.lastValidBlockHeight,
      summary,
      warnings,
    };
  }

  /** Withdraw first when the ledger holds free funds (spec 4.1, RED-11). */
  function bundleWithdraw(o: PublicKey, m: Market, p: Position, ixs: TransactionInstruction[], warnings: string[]): boolean {
    if (p.ledgerUsdc === 0n && p.ledgerYes === 0n) return false;
    ixs.push(ixWithdraw(o, m, deps.usdcMint));
    warnings.push("LEDGER_WITHDRAW_BUNDLED");
    return true;
  }

  /**
   * After a withdraw, Yes from a filled Sell No limit (a Yes bid) sits next to the user's
   * No: merge them for $1.00 a pair (spec 7.4 "later merge via claim", TRD-14). Only the
   * Yes coming out of the ledger is merged, so Yes the user holds on purpose (a maker's
   * minted inventory) and the No of a resting Buy No limit are left alone.
   */
  function bundleMerge(o: PublicKey, m: Market, p: Position, ixs: TransactionInstruction[], warnings: string[]): bigint {
    const freeNo = p.no - p.pendingNo;
    const n = p.ledgerYes < freeNo ? p.ledgerYes : freeNo;
    if (n <= 0n || m.status === "SETTLED" || m.status === "VOID") return 0n;
    ixs.push(ixMerge(o, m, deps.usdcMint, n));
    warnings.push("MERGE_BUNDLED");
    return n;
  }

  /**
   * Makers a taker would meet, in price-time order, until `qty` is covered (plus a couple
   * more in case the book moved). Their ledgers go in as remaining accounts; the program
   * stops matching at a maker whose ledger is missing.
   */
  function crossing(orders: RestingOrder[], takerSide: Side, limit: number, taker: string) {
    const makerSide = takerSide === "BID" ? "ASK" : "BID";
    return orders
      .filter((x) => x.side === makerSide && (takerSide === "BID" ? x.price <= limit : x.price >= limit))
      .sort((a, b) => (a.price !== b.price ? (takerSide === "BID" ? a.price - b.price : b.price - a.price) : a.id < b.id ? -1 : 1))
      .map((x) => ({ ...x, self: x.owner === taker }));
  }

  function makersFor(cross: ReturnType<typeof crossing>, qty: bigint, spare = 2): PublicKey[] {
    const out: string[] = [];
    let covered = 0n;
    let extra = 0;
    for (const x of cross) {
      if (x.self) continue; // the taker's own order is cancelled in place, with the taker's ledger
      if (covered >= qty) {
        if (extra >= spare) break;
        if (!out.includes(x.owner)) extra++;
      }
      if (!out.includes(x.owner)) out.push(x.owner);
      covered += x.qty;
    }
    return out.map((s) => new PublicKey(s));
  }

  // ---- POST /v1/tx/trade (MER-62) ----
  app.post("/v1/tx/trade", async (req) => {
    const b = body(req.body);
    const o = owner(b);
    if (!INTENTS.includes(b.intent as Intent)) throw new ApiError("VALIDATION", `intent must be one of ${INTENTS.join(", ")}`, { field: "intent" });
    if (!ORDER_TYPES.includes(b.orderType as (typeof ORDER_TYPES)[number])) throw new ApiError("VALIDATION", `orderType must be one of ${ORDER_TYPES.join(", ")}`, { field: "orderType" });
    const intent = b.intent as Intent;
    const type = b.orderType as (typeof ORDER_TYPES)[number];
    const qty = posInt(b, "qty");
    // A18: a MARKET order needs a worst acceptable price; LIMIT and POST_ONLY need a price.
    if (b.priceCents === undefined || b.priceCents === null) {
      throw new ApiError("VALIDATION", type === "MARKET" ? "MARKET orders need priceCents as the worst acceptable price" : "priceCents is required", { field: "priceCents" });
    }
    const p = cents(b, "priceCents");
    if (type === "POST_ONLY" && (intent === "BUY_NO" || intent === "SELL_NO")) throw new ApiError("VALIDATION", "POST_ONLY is only available for Yes intents", { field: "orderType" });
    if (b.clientOrderId !== undefined && (typeof b.clientOrderId !== "string" || b.clientOrderId.length > 64)) throw new ApiError("VALIDATION", "clientOrderId must be a string of at most 64 characters", { field: "clientOrderId" });

    const [c, m] = await Promise.all([cfg(), market(b)]);
    // D6: the same 500-contract cap for the manual form and the assistant.
    if (qty > BigInt(c.maxQty)) throw new ApiError("ORDER_TOO_LARGE", `At most ${c.maxQty} contracts per trade; reduce the size or split the order`, { maxQty: c.maxQty, qty: Number(qty) });
    entryGuards(m, c, "trade");

    const ownerS = o.toBase58();
    const [{ pos, open }, orders, balS] = await Promise.all([position(o, m), book(m), redis.get(K.bal(ownerS))]);
    const ixs: TransactionInstruction[] = [];
    const warnings: string[] = [];
    const withdrew = bundleWithdraw(o, m, pos, ixs, warnings);
    const merged = withdrew ? bundleMerge(o, m, pos, ixs, warnings) : 0n;
    const yes = pos.yes - merged;
    const no = pos.no - merged;
    const lockedAsk = open.filter((x) => x.side === "ASK").reduce((a, x) => a + x.qty, 0n);

    // Position guards (PRD "Position Constraints", A10): exit one side before entering the other.
    const conflict = (requiredAction: string, msg: string, extra: Record<string, unknown> = {}) =>
      new ApiError("POSITION_CONFLICT", msg, { requiredAction, yes: Number(yes), no: Number(no), ...extra });
    if (intent === "BUY_YES" && no > 0n) throw conflict(pos.pendingNo > 0n ? "CANCEL_BUY_NO" : "SELL_NO", "Sell your No first");
    if (intent === "BUY_NO" && yes - pos.pendingNo > 0n) throw conflict("SELL_YES", "Sell your Yes first");
    if (intent === "SELL_NO" && qty > no - pos.pendingNo) throw conflict("REDUCE_QTY", `You hold ${no - pos.pendingNo} No`, { available: Number(no - pos.pendingNo) });
    if (intent === "SELL_YES" && qty > yes - lockedAsk) throw conflict("REDUCE_QTY", `You hold ${yes - lockedAsk} Yes not already offered`, { available: Number(yes - lockedAsk) });

    // Intent → instruction (spec 7.4 table). No prices convert with 100 − n.
    const isNo = intent === "BUY_NO" || intent === "SELL_NO";
    const yesPrice = isNo ? 100 - p : p;
    const takerSide: Side = intent === "BUY_YES" || intent === "SELL_NO" ? "BID" : "ASK";
    const cross = type === "POST_ONLY" ? [] : crossing(orders, takerSide, yesPrice, ownerS);
    const available = cross.filter((x) => !x.self).reduce((a, x) => a + x.qty, 0n);
    if (type === "MARKET") {
      if (available === 0n) throw new ApiError("NO_LIQUIDITY", `Nothing to ${takerSide === "BID" ? "buy" : "sell"} into at ${p}¢ or better`, { worstPriceCents: p });
      if (available < qty) warnings.push("PARTIAL_FILL_LIKELY");
    }
    if (type === "POST_ONLY" && crossing(orders, takerSide, yesPrice, ownerS).some((x) => !x.self)) {
      throw new ApiError("VALIDATION", "A POST_ONLY order at this price would cross the book", { field: "priceCents" });
    }
    let makers = makersFor(cross, qty);

    const notional = qty * BigInt(p) * 10_000n;
    const fee = takerFee(qty * BigInt(yesPrice) * 10_000n, c.feeBps);
    const buying = intent === "BUY_YES" || intent === "BUY_NO";
    // USDC the wallet must hold: buys pay up to notional + fee; a Buy No limit mints the full $1.00 a pair up front.
    const upfront = intent === "BUY_NO" && type !== "MARKET" ? qty * 1_000_000n : buying ? notional + fee : 0n;
    if (balS !== null && upfront > 0n && BigInt(balS) + (withdrew ? pos.ledgerUsdc : 0n) < upfront) {
      throw new ApiError("INSUFFICIENT_BALANCE", `This needs ${microToDollars(upfront)} USDC in your wallet`, { required: upfront.toString(), available: balS });
    }

    const clientId = b.clientOrderId ? createHash("sha256").update(b.clientOrderId as string).digest().readBigUInt64LE(0) : randomBytes(8).readBigUInt64LE(0);
    const tradeIx = (mk: PublicKey[]) => {
      switch (intent) {
        case "BUY_YES":
          return ixPlaceOrder(o, m, deps.usdcMint, "BID", p, qty, type === "MARKET" ? "IOC" : type === "LIMIT" ? "GTC" : "POST_ONLY", clientId, mk);
        case "SELL_YES":
          return ixPlaceOrder(o, m, deps.usdcMint, "ASK", p, qty, type === "MARKET" ? "IOC" : type === "LIMIT" ? "GTC" : "POST_ONLY", clientId, mk);
        case "BUY_NO":
          return type === "MARKET" ? ixBuyNoMarket(o, m, deps.usdcMint, qty, yesPrice, mk) : ixBuyNoLimit(o, m, deps.usdcMint, qty, yesPrice, mk);
        case "SELL_NO":
          return type === "MARKET" ? ixSellNo(o, m, deps.usdcMint, qty, yesPrice, mk) : ixPlaceOrder(o, m, deps.usdcMint, "BID", yesPrice, qty, "GTC", clientId, mk);
      }
    };
    const alt = deps.alts.get(m.symbol, m.date);
    let built: { tx: VersionedTransaction; size: number };
    for (;;) {
      const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(1_400_000, 200_000 + 60_000 * (makers.length + ixs.length)) });
      built = compile(o, [cu, ...ixs, tradeIx(makers)], alt);
      if (built.size <= MAX_TX_BYTES) break;
      if (makers.length === 0) throw new ApiError("VALIDATION", "Transaction too large", { bytes: built.size });
      makers = makers.slice(0, -1);
      if (!warnings.includes("PARTIAL_FILL_LIKELY")) warnings.push("PARTIAL_FILL_LIKELY");
    }

    const summary = {
      intent, orderType: type, qty: Number(qty), worstPriceCents: p, yesPriceCents: yesPrice,
      maxCost: buying ? (notional + fee).toString() : "0",
      minProceeds: buying ? "0" : (notional - fee).toString(),
      payoutIfWin: buying ? (qty * 1_000_000n).toString() : "0",
      upfront: upfront.toString(),
      fee: fee.toString(),
      copy: summaryCopy(intent, m.symbol, m.strikeCents, qty, p, fee),
      instruction: intent === "BUY_NO" ? (type === "MARKET" ? "buy_no_market" : "buy_no_limit") : intent === "SELL_NO" && type === "MARKET" ? "sell_no" : "place_order",
      makers: makers.length,
    };
    return respond(built.tx, summary, warnings);
  });

  // ---- MER-63: cancel, mint, merge, withdraw, redeem, dispute ----
  app.post("/v1/tx/cancel", async (req) => {
    const b = body(req.body);
    const o = owner(b);
    const m = await market(b);
    const { pos, open } = await position(o, m);
    const ixs: TransactionInstruction[] = [];
    const warnings: string[] = [];
    let summary: Record<string, unknown>;
    if (b.all === true) {
      if (open.length === 0) throw new ApiError("NOT_FOUND", "No open orders on this market");
      ixs.push(ixCancelAll(o, m, deps.usdcMint));
      summary = { action: "CANCEL_ALL", orders: open.length, copy: `Cancel ${open.length} open order${open.length === 1 ? "" : "s"}.` };
    } else {
      if (typeof b.orderId !== "string" || !/^\d{1,20}$/.test(b.orderId)) throw new ApiError("VALIDATION", "orderId must be a decimal string (or set all: true)", { field: "orderId" });
      const id = BigInt(b.orderId);
      const ord = open.find((x) => x.id === id);
      if (!ord) throw new ApiError("NOT_FOUND", `No open order ${b.orderId} of yours on this market`);
      ixs.push(ixCancelOrder(o, m, deps.usdcMint, id));
      // A cancelled Buy No limit merges its Yes back with the No: the $1.00 a pair comes back (D15).
      summary = ord.tag === "BUY_NO"
        ? { action: "CANCEL", orderId: b.orderId, intent: "BUY_NO", mergesPairs: Number(ord.qty), copy: `Cancel your Buy No; ${ord.qty} pairs merge back to ${microToDollars(ord.qty * 1_000_000n)}.` }
        : { action: "CANCEL", orderId: b.orderId, intent: ord.side === "BID" ? "BUY_YES" : "SELL_YES", copy: "Cancel this order." };
    }
    if (pos.ledgerUsdc > 0n || pos.ledgerYes > 0n) {
      ixs.push(ixWithdraw(o, m, deps.usdcMint));
      warnings.push("LEDGER_WITHDRAW_BUNDLED");
    }
    return respond(compile(o, ixs, deps.alts.get(m.symbol, m.date)).tx, summary, warnings);
  });

  app.post("/v1/tx/mint", async (req) => {
    const b = body(req.body);
    const o = owner(b);
    const n = posInt(b, "pairs");
    const [c, m] = await Promise.all([cfg(), market(b)]);
    if (n > BigInt(c.maxQty)) throw new ApiError("ORDER_TOO_LARGE", `At most ${c.maxQty} pairs per transaction`, { maxQty: c.maxQty });
    entryGuards(m, c, "mint");
    const bal = await redis.get(K.bal(o.toBase58()));
    if (bal !== null && BigInt(bal) < n * 1_000_000n) throw new ApiError("INSUFFICIENT_BALANCE", `Minting ${n} pairs needs ${microToDollars(n * 1_000_000n)} USDC`, { required: (n * 1_000_000n).toString(), available: bal });
    const summary = { action: "MINT", pairs: Number(n), maxCost: (n * 1_000_000n).toString(), copy: `You pay ${microToDollars(n * 1_000_000n)} for ${n} Yes and ${n} No.` };
    return respond(compile(o, [ixMint(o, m, deps.usdcMint, n)], deps.alts.get(m.symbol, m.date)).tx, summary, []);
  });

  app.post("/v1/tx/merge", async (req) => {
    const b = body(req.body);
    const o = owner(b);
    const n = posInt(b, "pairs");
    const m = await market(b);
    if (m.status === "SETTLED" || m.status === "VOID") throw new ApiError("MARKET_HALTED", "The market has settled; redeem instead", { status: m.status });
    const { pos, open } = await position(o, m);
    const ixs: TransactionInstruction[] = [];
    const warnings: string[] = [];
    bundleWithdraw(o, m, pos, ixs, warnings);
    const locked = open.filter((x) => x.side === "ASK").reduce((a, x) => a + x.qty, 0n);
    const can = (pos.yes - locked < pos.no ? pos.yes - locked : pos.no);
    if (n > can) throw new ApiError("POSITION_CONFLICT", `You can merge at most ${can < 0n ? 0n : can} pairs`, { requiredAction: "REDUCE_QTY", available: Number(can < 0n ? 0n : can) });
    ixs.push(ixMerge(o, m, deps.usdcMint, n));
    const summary = { action: "MERGE", pairs: Number(n), minProceeds: (n * 1_000_000n).toString(), copy: `You receive ${microToDollars(n * 1_000_000n)} for ${n} Yes and ${n} No.` };
    return respond(compile(o, ixs, deps.alts.get(m.symbol, m.date)).tx, summary, warnings);
  });

  app.post("/v1/tx/withdraw", async (req) => {
    const b = body(req.body);
    const o = owner(b);
    const m = await market(b);
    const { pos, open } = await position(o, m);
    const ixs: TransactionInstruction[] = [];
    const warnings: string[] = [];
    if (!bundleWithdraw(o, m, pos, ixs, warnings)) throw new ApiError("NOT_FOUND", "Nothing to withdraw on this market");
    warnings.length = 0; // the withdraw is the point here, not a bundled extra
    bundleMerge(o, m, pos, ixs, warnings);
    const summary = { action: "WITHDRAW", usdc: pos.ledgerUsdc.toString(), yes: Number(pos.ledgerYes), copy: `Move ${microToDollars(pos.ledgerUsdc)} and ${pos.ledgerYes} Yes from the market to your wallet.` };
    return respond(compile(o, ixs, deps.alts.get(m.symbol, m.date)).tx, summary, warnings);
  });

  // Redeem many markets (RED-09): one tx while it fits 1,232 bytes (with the ticker-day ALT), else several.
  app.post("/v1/tx/redeem", async (req) => {
    const b = body(req.body);
    const o = owner(b);
    if (!Array.isArray(b.marketIds) || b.marketIds.length === 0 || b.marketIds.length > 50) throw new ApiError("VALIDATION", "marketIds must list 1 to 50 markets", { field: "marketIds" });
    const ids = [...new Set(b.marketIds as unknown[])];
    const groups: { ixs: TransactionInstruction[]; m: Market }[] = [];
    let payout = 0n;
    const warnings: string[] = [];
    for (const id of ids) {
      const m = await market({ marketId: id });
      if (m.status !== "SETTLED" && m.status !== "VOID") throw new ApiError("NOT_SETTLED", `Market ${m.id} has not settled yet`, { marketId: m.id });
      const { pos } = await position(o, m);
      if (pos.yes === 0n && pos.no === 0n) continue;
      const ixs: TransactionInstruction[] = [];
      if (pos.ledgerUsdc > 0n || pos.ledgerYes > 0n) {
        ixs.push(ixWithdraw(o, m, deps.usdcMint));
        if (!warnings.includes("LEDGER_WITHDRAW_BUNDLED")) warnings.push("LEDGER_WITHDRAW_BUNDLED");
      }
      ixs.push(ixCreateAtaIdempotent(o, m.yesMint), ixCreateAtaIdempotent(o, m.noMint), ixRedeem(o, m, deps.usdcMint, pos.yes, pos.no));
      const outcome = await redis.hget(K.mkt(m.id), "outcome");
      payout += m.status === "VOID" ? (pos.yes + pos.no) * 500_000n : (outcome === "YES" ? pos.yes : outcome === "NO" ? pos.no : 0n) * 1_000_000n;
      groups.push({ ixs, m });
    }
    if (groups.length === 0) throw new ApiError("NOT_FOUND", "Nothing to redeem in these markets");
    // Greedy packing: add markets to the current tx while it still fits.
    const txs: VersionedTransaction[] = [];
    let cur: TransactionInstruction[] = [];
    let curAlt: AddressLookupTableAccount | null = null;
    for (const g of groups) {
      const alt = deps.alts.get(g.m.symbol, g.m.date);
      const tryIxs = [...cur, ...g.ixs];
      const prevAlt = curAlt as AddressLookupTableAccount | null;
      const sameAlt = cur.length === 0 || prevAlt?.key.toBase58() === alt?.key.toBase58();
      const fits = sameAlt && compile(o, tryIxs, alt).size <= MAX_TX_BYTES;
      if (fits) {
        cur = tryIxs;
        curAlt = alt;
        continue;
      }
      if (cur.length === 0) throw new ApiError("VALIDATION", "A single redeem does not fit in a transaction");
      txs.push(compile(o, cur, curAlt).tx);
      cur = g.ixs;
      curAlt = alt;
    }
    txs.push(compile(o, cur, curAlt).tx);
    if (txs.length > 1) warnings.push("SPLIT_INTO_MULTIPLE_TXS");
    const summary = { action: "REDEEM", markets: groups.length, payout: payout.toString(), transactions: txs.length, copy: `You receive ${microToDollars(payout)}.` };
    return { ...respond(txs[0]!, summary, warnings), transactions: txs.map((t) => Buffer.from(t.serialize()).toString("base64")) };
  });

  // Dispute (D8): only while the recorded close is PROVISIONAL and the window is open.
  app.post("/v1/tx/dispute", async (req) => {
    const b = body(req.body);
    const o = owner(b);
    const symbol = typeof b.symbol === "string" ? b.symbol.toUpperCase() : "";
    const date = isoToKey(b.date);
    if (!/^[A-Z]{1,8}$/.test(symbol)) throw new ApiError("VALIDATION", "symbol is required", { field: "symbol" });
    if (date == null) throw new ApiError("VALIDATION", "date must be YYYY-MM-DD", { field: "date" });
    if (typeof b.evidenceUrl !== "string" || !/^https:\/\/\S{3,2000}$/.test(b.evidenceUrl)) throw new ApiError("VALIDATION", "evidenceUrl must be an https URL", { field: "evidenceUrl" });
    const td = await redis.hgetall(K.tday(symbol, date));
    if (!td.status && !td.close_time) throw new ApiError("NOT_FOUND", `No ticker-day ${symbol} ${keyToIso(date)}`);
    const end = Number(td.final_at_est ?? 0);
    if (td.status !== "PROVISIONAL" || nowS() >= end) throw new ApiError("DISPUTE_WINDOW_CLOSED", "Disputes are only open for 20 minutes after the close is recorded", { status: td.status || "OPEN", windowEnd: end || null });
    const bond = deps.disputeBondMicro ?? 100_000_000n;
    const bal = await redis.get(K.bal(o.toBase58()));
    if (bal !== null && BigInt(bal) < bond) throw new ApiError("INSUFFICIENT_BALANCE", `The dispute bond is ${microToDollars(bond)} USDC`, { required: bond.toString(), available: bal });
    const hash = createHash("sha256").update(b.evidenceUrl).digest();
    const ix = ixRaiseDispute(o, symbol, date, deps.usdcMint, deps.bondVault, hash);
    const summary = {
      action: "DISPUTE", symbol, date: keyToIso(date), bond: bond.toString(), evidenceHash: hash.toString("hex"),
      copy: `You post a ${microToDollars(bond)} bond. It comes back only if the price is corrected or the 24-hour deadline passes without a decision; if the price is upheld it goes to the fee vault.`,
    };
    return respond(compile(o, [ix], null).tx, summary, []);
  });

  return app;
}
