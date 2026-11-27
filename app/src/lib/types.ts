/** Response shapes of the Phase 6 services (spec 7, as built in services/api, txb, ws). */
export type Phase = "PRE_OPEN" | "MINT_ONLY" | "TRADING" | "HALTED" | "SETTLING" | "PROVISIONAL" | "DISPUTED" | "SETTLED" | "CLOSED_DAY";
export type Intent = "BUY_YES" | "SELL_YES" | "BUY_NO" | "SELL_NO";
export type View = "YES" | "NO";
export type Level = [number, number];

export interface Status {
  paused: boolean;
  slot: number | null;
  tradingDate: string;
  phase: Phase;
  openTime: string | null;
  closeTime: string | null;
  closeTimeUnix: number | null;
  serverTime: string;
}

export interface Ticker {
  symbol: string;
  underlying: { price: string; conf: string | null; publishTime: string | null } | null;
  prevClose: string | null;
  activeMarkets: number;
  tickerDayStatus: string | null;
}
export interface TickersResponse { data: Ticker[] }

export interface Market {
  marketId: string;
  symbol: string;
  tradingDate: string;
  strike: string;
  strikeCents: number;
  question: string;
  status: "PRE_OPEN" | "MINT_ONLY" | "TRADING" | "HALTED" | "SETTLED" | "VOID";
  outcome: "YES" | "NO" | "VOID" | null;
  yes: { bid: number | null; ask: number | null; last: number | null };
  no: { bid: number | null; ask: number | null };
  impliedProbability: number | null;
  volume: number;
  pairsOutstanding: number;
  yesMint: string;
  noMint: string;
  openTime: string | null;
  closeTime: string | null;
  closeTimeUnix: number | null;
  seq: string;
}
export interface MarketDetail extends Market { outcomeProvisional?: boolean; settlePrice?: string | null }
export interface MarketsResponse { symbol: string; tradingDate: string; closeTime: string | null; closeTimeUnix: number | null; markets: Market[] }

export interface BookSnapshot { marketId: string; seq: string; view: View; bids: Level[]; asks: Level[]; updatedAt: string | null }
export interface Trade { seq: string; priceCents: number; noPriceCents: number; qty: number; takerSide: string; time: string | null; signature: string }

export interface SettlementTicker {
  symbol: string;
  status: string;
  closePrice: string | null;
  publishTime: string | null;
  finalAt: string | null;
  markets: { marketId: string; strike: string; strikeCents: number; outcome: "YES" | "NO" | "VOID" | null; provisional: boolean; status: string }[];
}
export interface Settlements { tradingDate: string; tickers: SettlementTicker[] }

export interface Position {
  marketId: string;
  symbol: string;
  strike: string;
  side: "YES" | "NO" | "BOTH" | "BOTH_PENDING" | "FLAT";
  qty: number;
  yesQty: number;
  noQty: number;
  avgEntryCents: number | null;
  markCents: number | null;
  unrealizedPnl: string;
  realizedPnl: string;
  status: Market["status"];
  outcome: "YES" | "NO" | "VOID" | null;
  payoutIfWin: string;
  redeemable: string;
  redeemed: boolean;
  ledger: { freeUsdc: string; freeYes: number };
}

export interface Order {
  marketId: string;
  orderId: string;
  intent: Intent;
  bookSide: "BID" | "ASK";
  yesPriceCents: number;
  priceCents: number;
  qty: number;
  filled: number;
  remaining: number;
  tif: string;
  status: string;
  placedAt: string | null;
  signature: string | null;
}

export interface HistoryItem {
  time: string;
  marketId: string;
  intent: string; // BUY_YES | SELL_YES | BUY_NO | SELL_NO | MINT | MERGE | REDEEM
  qty: number;
  priceCents: number | null;
  fee: string;
  usdc: string | null;
  signature: string;
}

export interface Claimable {
  data: { marketId: string; symbol: string | null; strike: string | null; status: string | null; ledger: { freeUsdc: string; freeYes: number }; redeemable: string }[];
  totals: { ledgerUsdc: string; redeemable: string };
}

export interface Prefs { defaultView: View; slippageCents: number }

export interface TradeRequest {
  owner: string;
  marketId: string;
  intent: Intent;
  orderType: "MARKET" | "LIMIT";
  qty: number;
  priceCents: number;
  clientOrderId?: string;
}

export interface TxSummary {
  intent?: Intent;
  qty?: number;
  worstPriceCents?: number;
  maxCost?: string;
  minProceeds?: string;
  payoutIfWin?: string;
  copy: string;
  [k: string]: unknown;
}
export interface TxResponse {
  transaction: string;
  /** Redeem only: every transaction when the builder had to split the batch (the first is `transaction`). */
  transactions?: string[];
  lastValidBlockHeight: number;
  summary: TxSummary;
  warnings: string[];
}
