/**
 * Positions, intent mapping and P&L (MER-54, spec 5 `positions`, A10, A29, R7.1, R7.2).
 *
 * A pure fold over whole instructions (all events with the same sig and ix), so that
 * synthetic actions can be mapped back to what the user asked for:
 *
 *   Buy No  = PairMinted{via: BUY_NO} + the user selling Yes (taker ASK fills, or a resting
 *             ask tagged BUY_NO that makers fill later)
 *   Sell No = the user buying Yes (taker BID fills) + PairMerged{via: SELL_NO}
 *
 * Money is integer micro-USDC; 1 cent = 10,000 micro (D24). Cost basis is average cost
 * with taker fees included (D31/A29). A Buy No is booked at (100 − yes fill price) cents
 * per No token. Quantities count wallet + ledger free + locked in the book.
 *
 * The same code runs in the Indexer (Redis `md:pos`) and the PG Writer (`positions`), so
 * the two read models agree.
 */
import type { ChainEvent } from "./events.js";

export const MICRO_PER_CENT = 10_000n;
export const MICRO_PER_DOLLAR = 1_000_000n;

export type Intent = "BUY_YES" | "SELL_YES" | "BUY_NO" | "SELL_NO";
export type BookSide = "BID" | "ASK";
export type OrderTag = "NONE" | "BUY_NO" | "SELL_NO";
export type OrderStatus = "OPEN" | "PARTIAL" | "FILLED" | "CANCELLED";

export interface OrderState {
  market: string;
  orderId: bigint;
  owner: string;
  side: BookSide;
  price: number;
  qtyOriginal: bigint;
  qtyFilled: bigint;
  tif: string;
  tag: OrderTag;
  intent: Intent;
  status: OrderStatus;
  cancelReason: string | null;
  placedSig: string;
  placedAt: number;
  updatedAt: number;
}

export interface PositionState {
  owner: string;
  market: string;
  yes: bigint;
  no: bigint;
  /** Average-cost basis of all Yes held. */
  yesCost: bigint;
  /** Basis of all No held, including `pendingNo` at $1.00 each until their Yes sells. */
  noCost: bigint;
  realized: bigint;
  ledgerUsdc: bigint;
  ledgerYes: bigint;
  /** No from a Buy No limit whose Yes still rests in the book (A10: BOTH_PENDING). */
  pendingNo: bigint;
  redeemed: boolean;
  lastSeq: bigint;
  updatedAt: number;
}

export interface FillRow {
  sig: string;
  ev: number;
  market: string;
  seq: bigint;
  makerOrderId: bigint;
  maker: string;
  taker: string;
  takerSide: BookSide;
  price: number;
  qty: bigint;
  takerFee: bigint;
  makerIntent: Intent;
  takerIntent: Intent;
  slot: number;
  blockTime: number;
}

export interface MmrRow {
  sig: string;
  ev: number;
  market: string;
  owner: string;
  kind: "MINT" | "MERGE" | "REDEEM" | "WITHDRAW";
  via: string | null;
  yesQty: bigint;
  noQty: bigint;
  usdc: bigint;
  blockTime: number;
}

/** The slice of state an instruction touches; callers preload it (see `needs`). */
export interface MarketState {
  orders: Map<bigint, OrderState>;
  positions: Map<string, PositionState>;
}

export interface Applied {
  orders: Set<bigint>;
  owners: Set<string>;
  fills: FillRow[];
  mmr: MmrRow[];
  /** Change in pairs outstanding and contracts traded, and the last trade price. */
  pairsDelta: bigint;
  volumeDelta: bigint;
  lastPrice: number | null;
}

export function emptyPosition(owner: string, market: string): PositionState {
  return {
    owner, market, yes: 0n, no: 0n, yesCost: 0n, noCost: 0n, realized: 0n,
    ledgerUsdc: 0n, ledgerYes: 0n, pendingNo: 0n, redeemed: false, lastSeq: 0n, updatedAt: 0,
  };
}

const big = (v: unknown) => BigInt(v as string);
const str = (v: unknown) => String(v);

/** Owners and maker orders an instruction needs loaded before `applyInstruction`. */
export function needs(group: ChainEvent[]): { owners: Set<string>; orders: Set<bigint> } {
  const owners = new Set<string>();
  const orders = new Set<bigint>();
  for (const e of group) {
    const p = e.payload;
    for (const k of ["owner", "maker", "taker"]) if (typeof p[k] === "string") owners.add(p[k] as string);
    if (e.kind === "Fill") orders.add(big(p.maker_order_id));
    if (e.kind === "OrderCancelled" || e.kind === "OrderPlaced") orders.add(big(p.order_id));
  }
  return { owners, orders };
}

export function intentOfOrder(side: BookSide, tag: OrderTag): Intent {
  if (tag === "BUY_NO") return "BUY_NO";
  if (tag === "SELL_NO") return "SELL_NO";
  return side === "BID" ? "BUY_YES" : "SELL_YES";
}

/** The taker's intent for a fill, from the side it hit and the via of its pair event (R7.1). */
export function takerIntent(group: ChainEvent[], taker: string, side: BookSide): Intent {
  if (side === "ASK") {
    const buyNo = group.some((e) => e.kind === "PairMinted" && e.payload.via === "BUY_NO" && e.payload.owner === taker);
    return buyNo ? "BUY_NO" : "SELL_YES";
  }
  const sellNo = group.some((e) => e.kind === "PairMerged" && e.payload.via === "SELL_NO" && e.payload.owner === taker);
  return sellNo ? "SELL_NO" : "BUY_YES";
}

const opposite = (s: BookSide): BookSide => (s === "BID" ? "ASK" : "BID");

/** cost × q / qty, exact when q == qty. */
function share(cost: bigint, q: bigint, qty: bigint): bigint {
  if (qty <= 0n || q <= 0n) return 0n;
  if (q >= qty) return cost;
  return (cost * q) / qty;
}

/** Basis of the No that are not pending (pending No carry exactly $1.00 each). */
function settledNo(p: PositionState): { qty: bigint; cost: bigint } {
  return { qty: p.no - p.pendingNo, cost: p.noCost - p.pendingNo * MICRO_PER_DOLLAR };
}

/** Removes q No at their average basis; returns the basis removed. */
function takeNo(p: PositionState, q: bigint): bigint {
  const s = settledNo(p);
  const removed = share(s.cost, q, s.qty);
  p.no -= q;
  p.noCost -= removed;
  return removed;
}

function takeYes(p: PositionState, q: bigint): bigint {
  const removed = share(p.yesCost, q, p.yes);
  p.yes -= q;
  p.yesCost -= removed;
  return removed;
}

/**
 * Applies one whole instruction to the market state. Events must be in emission order
 * and must not have been applied before (callers dedupe on (sig, ix, ev)).
 */
export function applyInstruction(state: MarketState, group: ChainEvent[]): Applied {
  const out: Applied = {
    orders: new Set(), owners: new Set(), fills: [], mmr: [], pairsDelta: 0n, volumeDelta: 0n, lastPrice: null,
  };
  if (group.length === 0) return out;
  const pos = (owner: string, e: ChainEvent): PositionState => {
    const m = String(e.payload.market);
    let p = state.positions.get(owner);
    if (!p) {
      p = emptyPosition(owner, m);
      state.positions.set(owner, p);
    }
    const s = big(e.payload.seq);
    if (s > p.lastSeq) p.lastSeq = s;
    p.updatedAt = e.blockTime ?? p.updatedAt;
    out.owners.add(owner);
    return p;
  };
  const pruned = group.some((e) => e.kind === "OrderCancelled" && e.payload.reason === "PRUNE");

  for (const e of group) {
    const p = e.payload;
    const t = e.blockTime ?? 0;
    switch (e.kind) {
      case "OrderPlaced": {
        const side = str(p.side) as BookSide;
        const tag = str(p.tag) as OrderTag;
        const id = big(p.order_id);
        state.orders.set(id, {
          market: str(p.market), orderId: id, owner: str(p.owner), side, price: Number(p.price),
          qtyOriginal: big(p.qty), qtyFilled: 0n, tif: str(p.tif), tag, intent: intentOfOrder(side, tag),
          status: "OPEN", cancelReason: null, placedSig: e.sig, placedAt: t, updatedAt: t,
        });
        out.orders.add(id);
        if (tag === "BUY_NO") pos(str(p.owner), e).pendingNo += big(p.qty);
        else pos(str(p.owner), e);
        break;
      }
      case "Fill": {
        const takerSide = str(p.side) as BookSide;
        const price = Number(p.price);
        const qty = big(p.qty);
        const fee = big(p.taker_fee);
        const notional = BigInt(price) * MICRO_PER_CENT * qty;
        const makerId = big(p.maker_order_id);
        const order = state.orders.get(makerId);
        const makerSide = opposite(takerSide);
        const mIntent = order ? order.intent : intentOfOrder(makerSide, "NONE");
        const tIntent = takerIntent(group, str(p.taker), takerSide);
        out.fills.push({
          sig: e.sig, ev: e.ev, market: str(p.market), seq: big(p.seq), makerOrderId: makerId,
          maker: str(p.maker), taker: str(p.taker), takerSide, price, qty, takerFee: fee,
          makerIntent: mIntent, takerIntent: tIntent, slot: e.slot, blockTime: t,
        });
        out.volumeDelta += qty;
        out.lastPrice = price;
        if (order) {
          order.qtyFilled += qty;
          order.status = order.qtyFilled >= order.qtyOriginal ? "FILLED" : "PARTIAL";
          order.updatedAt = t;
          out.orders.add(makerId);
        }

        // Maker: proceeds and tokens land in its ledger (no maker fee).
        const mk = pos(str(p.maker), e);
        if (makerSide === "BID") {
          mk.yes += qty;
          mk.yesCost += notional;
          mk.ledgerYes += qty;
        } else if (mIntent === "BUY_NO") {
          mk.yes -= qty;
          mk.pendingNo -= qty < mk.pendingNo ? qty : mk.pendingNo;
          mk.noCost -= notional; // $1.00 paid at mint − Yes price received = No basis
          mk.ledgerUsdc += notional;
        } else {
          mk.realized += notional - takeYes(mk, qty);
          mk.ledgerUsdc += notional;
        }

        // Taker.
        const tk = pos(str(p.taker), e);
        switch (tIntent) {
          case "BUY_YES":
            tk.yes += qty;
            tk.yesCost += notional + fee;
            break;
          case "SELL_YES":
            tk.realized += notional - fee - takeYes(tk, qty);
            break;
          case "BUY_NO":
            tk.yes -= qty; // the minted Yes is sold at once
            tk.noCost -= notional - fee;
            break;
          case "SELL_NO":
            // Buys Yes and merges it with No for $1.00: proceeds per No = 100 − price.
            tk.realized += qty * MICRO_PER_DOLLAR - notional - fee;
            break;
        }
        break;
      }
      case "OrderCancelled": {
        const reason = str(p.reason);
        if (reason === "IOC_REMAINDER") break; // never rested
        const id = big(p.order_id);
        const order = state.orders.get(id);
        if (order) {
          order.status = "CANCELLED";
          order.cancelReason = reason;
          order.updatedAt = t;
          out.orders.add(id);
        }
        const q = big(p.qty);
        const o = pos(str(p.owner), e);
        if (str(p.side) === "BID") o.ledgerUsdc += BigInt(Number(p.price)) * MICRO_PER_CENT * q;
        else {
          o.ledgerYes += q;
          if (order?.tag === "BUY_NO") o.pendingNo -= q < o.pendingNo ? q : o.pendingNo;
        }
        break;
      }
      case "PairMinted": {
        const n = big(p.n);
        const o = pos(str(p.owner), e);
        o.yes += n;
        o.no += n;
        if (p.via === "BUY_NO") {
          o.noCost += n * MICRO_PER_DOLLAR; // reduced by the Yes proceeds as it sells
        } else {
          // A direct mint costs $1.00 a pair; split evenly between the two legs.
          o.yesCost += n * (MICRO_PER_DOLLAR / 2n);
          o.noCost += n * (MICRO_PER_DOLLAR / 2n);
        }
        out.pairsDelta += n;
        out.mmr.push({ sig: e.sig, ev: e.ev, market: str(p.market), owner: o.owner, kind: "MINT", via: str(p.via),
          yesQty: n, noQty: n, usdc: -n * MICRO_PER_DOLLAR, blockTime: t });
        break;
      }
      case "PairMerged": {
        const n = big(p.n);
        const o = pos(str(p.owner), e);
        const via = str(p.via);
        if (via === "SELL_NO") {
          // The Yes was bought in this instruction (its cost is in the fills' realized P&L).
          o.realized -= takeNo(o, n);
        } else if (via === "CANCEL_BUY_NO") {
          // Unfilled Buy No: the $1.00 paid at mint comes back. No P&L.
          o.yes -= n;
          o.no -= n;
          o.noCost -= n * MICRO_PER_DOLLAR;
          o.ledgerYes -= n < o.ledgerYes ? n : o.ledgerYes;
          if (pruned) o.ledgerUsdc += n * MICRO_PER_DOLLAR; // prune credits the ledger
        } else {
          const basis = takeYes(o, n) + takeNo(o, n);
          o.realized += n * MICRO_PER_DOLLAR - basis;
        }
        out.pairsDelta -= n;
        out.mmr.push({ sig: e.sig, ev: e.ev, market: str(p.market), owner: o.owner, kind: "MERGE", via,
          yesQty: n, noQty: n, usdc: n * MICRO_PER_DOLLAR, blockTime: t });
        break;
      }
      case "Withdrawn": {
        const o = pos(str(p.owner), e);
        const usdc = big(p.usdc);
        const yes = big(p.yes);
        o.ledgerUsdc -= usdc;
        o.ledgerYes -= yes;
        out.mmr.push({ sig: e.sig, ev: e.ev, market: str(p.market), owner: o.owner, kind: "WITHDRAW", via: null,
          yesQty: yes, noQty: 0n, usdc, blockTime: t });
        break;
      }
      case "Redeemed": {
        const o = pos(str(p.owner), e);
        const yesN = big(p.yes_n);
        const noN = big(p.no_n);
        const paid = big(p.paid);
        const basis = takeYes(o, yesN) + takeNo(o, noN);
        o.realized += paid - basis;
        o.redeemed = true;
        out.mmr.push({ sig: e.sig, ev: e.ev, market: str(p.market), owner: o.owner, kind: "REDEEM", via: null,
          yesQty: yesN, noQty: noN, usdc: paid, blockTime: t });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

// ---- Views ----

export type PositionSide = "YES" | "NO" | "BOTH_PENDING" | "FLAT";

export interface PositionView {
  side: PositionSide;
  qty: bigint;
  /** Average entry in cents (fees included), null when flat. */
  avgEntryCents: number | null;
  avgYesCents: number | null;
  avgNoCents: number | null;
  realizedPnl: bigint;
  unrealizedPnl: bigint;
}

const cents = (cost: bigint, qty: bigint) => (qty > 0n ? Number(cost) / Number(qty) / Number(MICRO_PER_CENT) : null);

export function avgYesCents(p: PositionState): number | null {
  return cents(p.yesCost, p.yes);
}

export function avgNoCents(p: PositionState): number | null {
  const s = settledNo(p);
  return cents(s.cost, s.qty);
}

/**
 * Side, average entry and P&L. `markYesCents` is the Yes mark (book mid, last trade, or
 * 100/0 once settled); the No mark is 100 − it. A resting Buy No limit is BOTH_PENDING
 * (A10): the user holds the unsold Yes and its No, shown as one pending Buy No.
 */
export function positionView(p: PositionState, markYesCents: number | null): PositionView {
  const s = settledNo(p);
  const freeYes = p.yes - p.pendingNo; // Yes not reserved for a pending Buy No
  let side: PositionSide = "FLAT";
  let qty = 0n;
  if (p.pendingNo > 0n) {
    side = "BOTH_PENDING";
    qty = p.no;
  } else if (p.yes > 0n && p.no === 0n) {
    side = "YES";
    qty = p.yes;
  } else if (p.no > 0n && p.yes === 0n) {
    side = "NO";
    qty = p.no;
  } else if (p.yes > 0n || p.no > 0n) {
    side = p.yes >= p.no ? "YES" : "NO";
    qty = p.yes >= p.no ? p.yes : p.no;
  }
  let unrealized = 0n;
  if (markYesCents != null) {
    const yesMark = BigInt(Math.round(markYesCents * Number(MICRO_PER_CENT)));
    const noMark = 100n * MICRO_PER_CENT - yesMark;
    const yesHeld = freeYes > 0n ? freeYes : 0n;
    // Pending Buy No Yes carry no basis, so all of yesCost belongs to the free Yes.
    if (yesHeld > 0n) unrealized += yesHeld * yesMark - p.yesCost;
    if (s.qty > 0n) unrealized += s.qty * noMark - s.cost;
  }
  const avg = side === "YES" ? avgYesCents(p) : side === "FLAT" ? null : avgNoCents(p);
  return {
    side, qty, avgEntryCents: side === "FLAT" ? null : avg, avgYesCents: avgYesCents(p), avgNoCents: avgNoCents(p),
    realizedPnl: p.realized, unrealizedPnl: unrealized,
  };
}
