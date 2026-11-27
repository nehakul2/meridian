/**
 * MER-51: projects decoded events into the Redis read model (spec 6.1) and publishes the
 * matching deltas (spec 6.2). One whole instruction is applied per call, in one
 * MULTI/EXEC, so a reader never sees a snapshot that disagrees with a published delta
 * (spec 6.4, IDX-07). Every market-scoped value carries the event `seq`; an event whose
 * seq is not above the market's stored seq has already been applied and is skipped, so a
 * replay after a crash or a failover cannot double-apply.
 *
 * The book is projected from events: OrderPlaced adds the rested quantity, a Fill takes
 * the filled quantity off the maker's level, and a cancel (other than an IOC remainder,
 * which never rested) takes the cancelled quantity off. `resyncBook` can overwrite the
 * levels from the OrderBook account when needed.
 */
import type { ChainableCommander, Redis } from "ioredis";
import {
  ChainEvent, isMarketScoped,
} from "../../shared/src/events.js";
import {
  applyInstruction, avgNoCents, avgYesCents, BookSide, emptyPosition, MarketState, needs, OrderState, PositionState,
} from "../../shared/src/positions.js";
import { K, TTL } from "../../shared/src/keys.js";

/** Runs a MULTI that only commits while this process holds the leader lease (MER-52). */
export interface WriteGuard {
  exec(redis: Redis, build: (m: ChainableCommander) => void): Promise<void>;
}

export const noGuard: WriteGuard = {
  async exec(redis, build) {
    const m = redis.multi();
    build(m);
    const r = await m.exec();
    if (!r) throw new Error("MULTI aborted");
    for (const [err] of r) if (err) throw err;
  },
};

export interface ProjectorOptions {
  guard?: WriteGuard;
  /** Dispute window, for `md:tday.final_at_est` (D8: 20 min). */
  disputeWindowS?: number;
  now?: () => number;
}

const SNAPSHOT_LEVELS = 20;

type Levels = Map<string, bigint>; // "B:61" -> qty

function posJson(p: PositionState): string {
  return JSON.stringify({
    yes: Number(p.yes), no: Number(p.no), ledger_usdc: p.ledgerUsdc.toString(), ledger_yes: Number(p.ledgerYes),
    avg_yes: avgYesCents(p), avg_no: avgNoCents(p),
    yes_cost: p.yesCost.toString(), no_cost: p.noCost.toString(), realized: p.realized.toString(),
    pending_no: Number(p.pendingNo), redeemed: p.redeemed, last_seq: p.lastSeq.toString(),
  });
}

function posFromJson(owner: string, market: string, s: string | null): PositionState {
  if (!s) return emptyPosition(owner, market);
  const j = JSON.parse(s) as Record<string, string | number | boolean>;
  return {
    owner, market, yes: BigInt(j.yes as number), no: BigInt(j.no as number), yesCost: BigInt(j.yes_cost as string),
    noCost: BigInt(j.no_cost as string), realized: BigInt(j.realized as string), ledgerUsdc: BigInt(j.ledger_usdc as string),
    ledgerYes: BigInt(j.ledger_yes as number), pendingNo: BigInt(j.pending_no as number), redeemed: !!j.redeemed,
    lastSeq: BigInt(j.last_seq as string), updatedAt: 0,
  };
}

function orderJson(o: OrderState): string {
  return JSON.stringify({
    market: o.market, order_id: o.orderId.toString(), owner: o.owner, side: o.side, price: o.price,
    qty: Number(o.qtyOriginal - o.qtyFilled), qty_original: Number(o.qtyOriginal), qty_filled: Number(o.qtyFilled),
    tif: o.tif, tag: o.tag, intent: o.intent, status: o.status, placed_sig: o.placedSig, placed_at: o.placedAt,
  });
}

/** `md:book:{m}:ord` value: what a taker needs to know about a resting order. */
function ordJson(o: OrderState): string {
  return JSON.stringify({ owner: o.owner, side: o.side, price: o.price, qty: Number(o.qtyOriginal - o.qtyFilled), tag: o.tag });
}

function orderFromJson(s: string): OrderState {
  const j = JSON.parse(s) as Record<string, string | number>;
  return {
    market: String(j.market), orderId: BigInt(j.order_id as string), owner: String(j.owner), side: j.side as BookSide,
    price: Number(j.price), qtyOriginal: BigInt(j.qty_original as number), qtyFilled: BigInt(j.qty_filled as number),
    tif: String(j.tif), tag: j.tag as OrderState["tag"], intent: j.intent as OrderState["intent"],
    status: j.status as OrderState["status"], cancelReason: null, placedSig: String(j.placed_sig),
    placedAt: Number(j.placed_at), updatedAt: Number(j.placed_at),
  };
}

function priceDecimal(raw: string, expo: number): string {
  const neg = raw.startsWith("-");
  const digits = neg ? raw.slice(1) : raw;
  if (expo >= 0) return (neg ? "-" : "") + digits + "0".repeat(expo);
  const pad = digits.padStart(-expo + 1, "0");
  const int = pad.slice(0, pad.length + expo);
  const frac = pad.slice(pad.length + expo).replace(/0+$/, "");
  return (neg ? "-" : "") + int + (frac ? "." + frac : "");
}

export class Projector {
  private readonly guard: WriteGuard;
  private readonly disputeWindowS: number;
  private readonly now: () => number;
  /** Close price exponent per ticker-day, from CloseRecorded (DisputeResolved/CloseFinalized omit it). */
  private readonly expo = new Map<string, number>();

  constructor(private readonly redis: Redis, o: ProjectorOptions = {}) {
    this.guard = o.guard ?? noGuard;
    this.disputeWindowS = o.disputeWindowS ?? 1200;
    this.now = o.now ?? (() => Date.now());
  }

  /** Applies one whole instruction (events with the same sig and ix, in order). */
  async applyInstruction(group: ChainEvent[]): Promise<void> {
    if (group.length === 0) return;
    if (!isMarketScoped(group[0]!)) return this.applyGlobal(group);
    const m = String(group[0]!.payload.market);
    const stored = BigInt((await this.redis.hget(K.mkt(m), "seq")) ?? "0");
    const fresh = group.filter((e) => BigInt(e.payload.seq as string) > stored);
    if (fresh.length === 0) return;
    await this.applyMarket(m, fresh, group);
  }

  private async loadState(m: string, group: ChainEvent[]): Promise<{ state: MarketState; levels: Levels; prevBookSeq: string }> {
    const need = needs(group);
    const owners = [...need.owners];
    const state: MarketState = { orders: new Map(), positions: new Map() };
    const p = this.redis.pipeline();
    for (const o of owners) p.hget(K.pos(o), m);
    // Orders this instruction touches, looked up in the owner's open-order hash.
    const orderOwner: [bigint, string][] = [];
    for (const e of group) {
      if (e.kind === "Fill") orderOwner.push([BigInt(e.payload.maker_order_id as string), String(e.payload.maker)]);
      if (e.kind === "OrderCancelled") orderOwner.push([BigInt(e.payload.order_id as string), String(e.payload.owner)]);
    }
    for (const [id, o] of orderOwner) p.hget(K.oo(o), `${m}:${id}`);
    p.hgetall(K.lvl(m));
    p.get(K.snap(m));
    const res = (await p.exec())!;
    owners.forEach((o, i) => state.positions.set(o, posFromJson(o, m, res[i]![1] as string | null)));
    orderOwner.forEach(([id], i) => {
      const s = res[owners.length + i]![1] as string | null;
      if (s) state.orders.set(id, orderFromJson(s));
    });
    const lvl = res.at(-2)![1] as Record<string, string>;
    const levels: Levels = new Map(Object.entries(lvl).map(([k, v]) => [k, BigInt(v)]));
    const snap = res.at(-1)![1] as string | null;
    const prevBookSeq = snap ? String((JSON.parse(snap) as { seq: string }).seq) : "0";
    return { state, levels, prevBookSeq };
  }

  private async applyMarket(m: string, events: ChainEvent[], whole: ChainEvent[]): Promise<void> {
    const { state, levels, prevBookSeq } = await this.loadState(m, whole);
    const before = new Map(levels);
    // Intent mapping needs the whole instruction; apply only the fresh events.
    const applied = applyInstruction(state, events.length === whole.length ? whole : events);
    const lastSeq = BigInt(events.at(-1)!.payload.seq as string);
    const ts = this.now();

    const bump = (side: BookSide, price: number, d: bigint) => {
      const k = `${side === "BID" ? "B" : "A"}:${price}`;
      const q = (levels.get(k) ?? 0n) + d;
      if (q > 0n) levels.set(k, q);
      else levels.delete(k);
    };
    let bookClosed = false;
    let created: ChainEvent | null = null;
    const statusMsgs: Record<string, unknown>[] = [];
    const mktFields: Record<string, string> = {};
    for (const e of events) {
      const p = e.payload;
      switch (e.kind) {
        case "OrderPlaced":
          if (BigInt(p.qty as string) > 0n) bump(p.side as BookSide, Number(p.price), BigInt(p.qty as string));
          break;
        case "Fill":
          bump(p.side === "BID" ? "ASK" : "BID", Number(p.price), -BigInt(p.qty as string));
          break;
        case "OrderCancelled":
          if (p.reason !== "IOC_REMAINDER") bump(p.side as BookSide, Number(p.price), -BigInt(p.qty as string));
          break;
        case "MarketCreated":
          created = e;
          break;
        case "MarketSettled":
          mktFields.status = "SETTLED";
          mktFields.outcome = String(p.outcome);
          mktFields.settle_price = String(p.settle_price);
          statusMsgs.push({ type: "market_status", status: "SETTLED", outcome: p.outcome, settle_price: p.settle_price, seq: String(p.seq) });
          break;
        case "MarketVoided":
          mktFields.status = "VOID";
          mktFields.outcome = "VOID";
          statusMsgs.push({ type: "market_status", status: "VOID", outcome: "VOID", seq: String(p.seq) });
          break;
        case "BookClosed":
          bookClosed = true;
          break;
        default:
          break;
      }
    }

    // MarketCreated needs the ticker-day's times if the TickerDay account was seen.
    let tdayTimes: Record<string, string> = {};
    if (created) {
      const c = created as ChainEvent;
      tdayTimes = await this.redis.hgetall(K.tday(String(c.payload.ticker), Number(c.payload.date)));
    }

    const changes: [string, number, number][] = [];
    for (const k of new Set([...before.keys(), ...levels.keys()])) {
      const a = before.get(k) ?? 0n;
      const b = levels.get(k) ?? 0n;
      if (a !== b) changes.push([k[0]!, Number(k.slice(2)), Number(b)]);
    }
    changes.sort((x, y) => (x[0] === y[0] ? x[1] - y[1] : x[0] < y[0] ? 1 : -1));

    await this.guard.exec(this.redis, (tx) => {
      if (created) {
        const c = (created as ChainEvent).payload;
        const d = Number(c.date);
        const t = String(c.ticker);
        tx.hset(K.mkt(m), {
          symbol: t, date: String(d), strike_cents: String(c.strike_cents), status: "TRADING", outcome: "",
          yes_mint: String(c.yes_mint), no_mint: String(c.no_mint), vault: String(c.vault), book: String(c.book),
          ticker_day: String(c.ticker_day), close_time: tdayTimes.close_time ?? "", open_time: tdayTimes.open_time ?? "",
          pairs_outstanding: "0", volume: "0", last_cents: "",
        });
        tx.sadd(K.dayMarkets(d), m);
        tx.expire(K.dayMarkets(d), TTL.day);
        tx.zadd(K.dayStrikes(d, t), Number(c.strike_cents), m);
        tx.expire(K.dayStrikes(d, t), TTL.day);
      }
      tx.hset(K.mkt(m), { seq: lastSeq.toString(), ...mktFields });
      if (applied.pairsDelta !== 0n) tx.hincrby(K.mkt(m), "pairs_outstanding", Number(applied.pairsDelta));
      if (applied.volumeDelta !== 0n) tx.hincrby(K.mkt(m), "volume", Number(applied.volumeDelta));
      if (applied.lastPrice != null) tx.hset(K.mkt(m), "last_cents", String(applied.lastPrice));
      tx.expire(K.mkt(m), TTL.mkt);

      // Book, snapshot, BBO and delta together.
      if (changes.length > 0 && !bookClosed) {
        for (const [s, price, q] of changes) {
          const zkey = s === "B" ? K.bids(m) : K.asks(m);
          if (q > 0) {
            tx.hset(K.lvl(m), `${s}:${price}`, String(q));
            tx.zadd(zkey, price, String(price));
          } else {
            tx.hdel(K.lvl(m), `${s}:${price}`);
            tx.zrem(zkey, String(price));
          }
        }
        const bids = [...levels].filter(([k]) => k[0] === "B").map(([k, q]) => [Number(k.slice(2)), Number(q)] as [number, number]).sort((a, b) => b[0] - a[0]);
        const asks = [...levels].filter(([k]) => k[0] === "A").map(([k, q]) => [Number(k.slice(2)), Number(q)] as [number, number]).sort((a, b) => a[0] - b[0]);
        tx.set(K.snap(m), JSON.stringify({ seq: lastSeq.toString(), bids: bids.slice(0, SNAPSHOT_LEVELS), asks: asks.slice(0, SNAPSHOT_LEVELS) }));
        const bid = bids[0];
        const ask = asks[0];
        tx.del(K.bbo(m));
        const bbo: Record<string, string> = { seq: lastSeq.toString(), ts: String(ts) };
        if (bid) Object.assign(bbo, { bid: String(bid[0]), bid_qty: String(bid[1]), no_ask: String(100 - bid[0]) });
        if (ask) Object.assign(bbo, { ask: String(ask[0]), ask_qty: String(ask[1]), no_bid: String(100 - ask[0]) });
        if (bid && ask) bbo.mid = String((bid[0] + ask[0]) / 2);
        tx.hset(K.bbo(m), bbo);
        // prev_seq = the seq of the snapshot this delta applies to, so a reader can tell a
        // missed delta from a market event that did not touch the book (Phase 6, WS-02).
        tx.publish(K.ch.book(m), JSON.stringify({ type: "book_delta", seq: lastSeq.toString(), prev_seq: prevBookSeq, changes }));
      }

      for (const f of applied.fills) {
        const trade = { type: "trade", seq: f.seq.toString(), price: f.price, qty: Number(f.qty), taker_side: f.takerSide, ts: f.blockTime };
        tx.lpush(K.trades(m), JSON.stringify({ ...trade, sig: f.sig, maker: f.maker, taker: f.taker }));
        tx.ltrim(K.trades(m), 0, 99);
        tx.expire(K.trades(m), TTL.trades);
        tx.publish(K.ch.trades(m), JSON.stringify(trade));
        for (const [who, intent] of [[f.maker, f.makerIntent], [f.taker, f.takerIntent]] as const) {
          tx.publish(K.ch.user(who), JSON.stringify({ type: "fill", market: m, seq: f.seq.toString(), price: f.price, qty: Number(f.qty), intent, sig: f.sig }));
        }
      }

      for (const id of applied.orders) {
        const o = state.orders.get(id)!;
        if (o.status === "OPEN" || o.status === "PARTIAL") {
          tx.hset(K.oo(o.owner), `${m}:${id}`, orderJson(o));
          // Per-book order index: the Tx Builder needs the makers in front of a taker (Phase 6).
          if (!bookClosed) tx.hset(K.ord(m), id.toString(), ordJson(o));
        } else {
          tx.hdel(K.oo(o.owner), `${m}:${id}`);
          tx.hdel(K.ord(m), id.toString());
        }
        tx.publish(K.ch.user(o.owner), JSON.stringify({ type: "order", market: m, order_id: id.toString(), status: o.status, qty: Number(o.qtyOriginal - o.qtyFilled) }));
      }

      for (const o of applied.owners) {
        const p = state.positions.get(o)!;
        tx.hset(K.pos(o), m, posJson(p));
        tx.expire(K.pos(o), TTL.pos);
        tx.publish(K.ch.user(o), JSON.stringify({ type: "position", market: m, ...JSON.parse(posJson(p)) }));
      }

      for (const msg of statusMsgs) tx.publish(K.ch.market(m), JSON.stringify(msg));
      if (bookClosed) {
        tx.del(K.bids(m), K.asks(m), K.lvl(m), K.snap(m), K.bbo(m), K.ord(m));
        tx.hset(K.mkt(m), "book", "");
        tx.publish(K.ch.market(m), JSON.stringify({ type: "book_closed", seq: lastSeq.toString() }));
      }
    });
  }

  /** Paused / Unpaused (Config) and the ticker-day level Close* / Dispute* events. */
  private async applyGlobal(group: ChainEvent[]): Promise<void> {
    await this.guard.exec(this.redis, (tx) => {
      for (const e of group) {
        const p = e.payload;
        if (e.kind === "Paused" || e.kind === "Unpaused") {
          const paused = e.kind === "Paused";
          tx.hset(K.cfg, "paused", paused ? "1" : "0");
          tx.publish(K.ch.sys, JSON.stringify({ type: paused ? "paused" : "unpaused", by: p.by, slot: e.slot }));
          continue;
        }
        const t = String(p.ticker);
        const d = Number(p.date);
        const key = K.tday(t, d);
        const tdKey = `${t}:${d}`;
        const f: Record<string, string> = { ticker_day: String(p.market) };
        switch (e.kind) {
          case "CloseRecorded": {
            const expo = Number(p.expo);
            this.expo.set(tdKey, expo);
            const at = e.blockTime ?? Math.floor(this.now() / 1000);
            Object.assign(f, {
              status: "PROVISIONAL", close_price: priceDecimal(String(p.price), expo), close_price_raw: String(p.price),
              expo: String(expo), conf: String(p.conf), publish_time: String(p.publish_time), recorded_by: String(p.by),
              recorded_at: String(at), final_at_est: String(at + this.disputeWindowS), override: p.override ? "1" : "0",
              dispute: "",
            });
            break;
          }
          case "DisputeRaised":
            Object.assign(f, { status: "DISPUTED", dispute: JSON.stringify({ by: p.by, bond: p.bond, evidence_hash: p.evidence_hash, raised_at: e.blockTime }) });
            break;
          case "DisputeResolved": {
            const expo = this.expo.get(tdKey);
            Object.assign(f, { dispute_result: String(p.result) });
            if (p.result === "CORRECTED") {
              Object.assign(f, { close_price_raw: String(p.new_price), original_price_raw: String(p.old_price) });
              if (expo != null) f.close_price = priceDecimal(String(p.new_price), expo);
            }
            break;
          }
          case "CloseFinalized": {
            const expo = this.expo.get(tdKey);
            Object.assign(f, { status: "FINAL", final_basis: String(p.basis), close_price_raw: String(p.price), final_at: String(e.blockTime ?? "") });
            if (expo != null) f.close_price = priceDecimal(String(p.price), expo);
            break;
          }
          default:
            break;
        }
        tx.hset(key, f);
        tx.expire(key, TTL.tday);
        tx.publish(K.ch.sys, JSON.stringify({ type: "settlement_progress", ticker: t, date: d, kind: e.kind, status: f.status ?? null }));
      }
    });
  }

  /** TickerDay account update: times for `md:tday` and the day's markets. */
  async applyTickerDay(td: { address: string; ticker: string; date: number; openTime: number; closeTime: number; mintOpenTime: number }): Promise<void> {
    const markets = await this.redis.zrange(K.dayStrikes(td.date, td.ticker), 0, -1);
    await this.guard.exec(this.redis, (tx) => {
      tx.hset(K.tday(td.ticker, td.date), {
        ticker_day: td.address, close_time: String(td.closeTime), open_time: String(td.openTime), mint_open_time: String(td.mintOpenTime),
      });
      tx.expire(K.tday(td.ticker, td.date), TTL.tday);
      for (const m of markets) tx.hset(K.mkt(m), { close_time: String(td.closeTime), open_time: String(td.openTime) });
    });
  }

  /** Config account update → `md:cfg` (max_qty_per_trade is the Tx Builder cap, D6). */
  async applyConfig(cfg: { paused: boolean; feeBps: number; overrideDelayS: number; settleWindowS: number; maxQtyPerTrade?: number }): Promise<void> {
    await this.guard.exec(this.redis, (tx) => {
      tx.hset(K.cfg, {
        paused: cfg.paused ? "1" : "0", fee_bps: String(cfg.feeBps), override_delay_s: String(cfg.overrideDelayS),
        settle_window_s: String(cfg.settleWindowS), max_qty_per_trade: String(cfg.maxQtyPerTrade ?? 500),
      });
    });
  }

  private readonly lastPx = new Map<string, number>();

  /**
   * Live underlying price → `md:px:{t}` (60 s TTL) and `md:ch:px:{t}`, published at most
   * 4 times a second per ticker (spec 6.2). Display only; never used for settlement.
   */
  async applyPrice(ticker: string, px: { price: string; conf: string; publishTime: number }): Promise<boolean> {
    const now = this.now();
    const publish = now - (this.lastPx.get(ticker) ?? -Infinity) >= 250;
    if (publish) this.lastPx.set(ticker, now);
    await this.guard.exec(this.redis, (tx) => {
      tx.hset(K.px(ticker), { price: px.price, conf: px.conf, publish_time: String(px.publishTime) });
      tx.expire(K.px(ticker), 60);
      if (publish) tx.publish(K.ch.px(ticker), JSON.stringify({ type: "underlying", price: px.price, conf: px.conf, publish_time: px.publishTime }));
    });
    return publish;
  }

  /** Wallet USDC balance → `md:bal:{o}:usdc` (1 d TTL) and a `balance` user message. */
  async applyBalance(owner: string, micro: bigint): Promise<void> {
    await this.guard.exec(this.redis, (tx) => {
      tx.set(K.bal(owner), micro.toString(), "EX", 86_400);
      tx.publish(K.ch.user(owner), JSON.stringify({ type: "balance", usdc: micro.toString() }));
    });
  }

  /**
   * Rebuilds one market from its remaining instructions after a confirmed signature was
   * dropped (IDX-05): clears the book, trades, counters, its open orders and positions,
   * replays, then publishes a fresh snapshot and every affected position as a correction.
   */
  async rebuildMarket(m: string, groups: ChainEvent[][], extraOwners: Iterable<string> = []): Promise<void> {
    const owners = new Set<string>(extraOwners);
    for (const g of groups) for (const o of needs(g).owners) owners.add(o);
    const ooKeys = await Promise.all([...owners].map(async (o) => [o, await this.redis.hkeys(K.oo(o))] as const));
    await this.guard.exec(this.redis, (tx) => {
      tx.del(K.bids(m), K.asks(m), K.lvl(m), K.snap(m), K.bbo(m), K.trades(m), K.ord(m));
      tx.hset(K.mkt(m), { seq: "0", pairs_outstanding: "0", volume: "0", last_cents: "" });
      for (const o of owners) tx.hdel(K.pos(o), m);
      for (const [o, keys] of ooKeys) for (const k of keys) if (k.startsWith(`${m}:`)) tx.hdel(K.oo(o), k);
    });
    for (const g of groups) await this.applyInstruction(g);
    const snap = await this.redis.get(K.snap(m));
    const seq = await this.redis.hget(K.mkt(m), "seq");
    await this.guard.exec(this.redis, (tx) => {
      const s = snap ? JSON.parse(snap) : { seq, bids: [], asks: [] };
      tx.publish(K.ch.book(m), JSON.stringify({ type: "book_snapshot", correction: true, ...s }));
      for (const o of owners) tx.publish(K.ch.user(o), JSON.stringify({ type: "position", market: m, correction: true }));
    });
  }

  /** Overwrites the levels from a decoded OrderBook account (orders aggregated per level). */
  async resyncBook(m: string, orders: { side: 0 | 1; price: number; qty: bigint }[]): Promise<void> {
    const levels: Levels = new Map();
    for (const o of orders) {
      const k = `${o.side === 0 ? "B" : "A"}:${o.price}`;
      levels.set(k, (levels.get(k) ?? 0n) + o.qty);
    }
    const seq = (await this.redis.hget(K.mkt(m), "seq")) ?? "0";
    const bids = [...levels].filter(([k]) => k[0] === "B").map(([k, q]) => [Number(k.slice(2)), Number(q)]).sort((a, b) => b[0]! - a[0]!);
    const asks = [...levels].filter(([k]) => k[0] === "A").map(([k, q]) => [Number(k.slice(2)), Number(q)]).sort((a, b) => a[0]! - b[0]!);
    await this.guard.exec(this.redis, (tx) => {
      tx.del(K.bids(m), K.asks(m), K.lvl(m));
      for (const [k, q] of levels) {
        tx.hset(K.lvl(m), k, q.toString());
        tx.zadd(k[0] === "B" ? K.bids(m) : K.asks(m), Number(k.slice(2)), k.slice(2));
      }
      const snap = { seq, bids: bids.slice(0, SNAPSHOT_LEVELS), asks: asks.slice(0, SNAPSHOT_LEVELS) };
      tx.set(K.snap(m), JSON.stringify(snap));
      tx.publish(K.ch.book(m), JSON.stringify({ type: "book_snapshot", correction: true, ...snap }));
    });
  }
}
