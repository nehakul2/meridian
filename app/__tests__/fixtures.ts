/** API fixtures in the Phase 6 response shapes (spec 7 examples, META 680 day of 2026-11-25). */
import type { BookSnapshot, HistoryItem, Market, MarketsResponse, Position, Settlements, Status, TickersResponse } from "@/lib/types";

export const CLOSE_UNIX = Date.parse("2026-11-25T21:00:00Z") / 1000; // 4:00 PM ET

export const status: Status = {
  paused: false, slot: 312884551, tradingDate: "2026-11-25", phase: "TRADING",
  openTime: "2026-11-25T14:30:00Z", closeTime: "2026-11-25T21:00:00Z", closeTimeUnix: CLOSE_UNIX, serverTime: "2026-11-25T19:12:03Z",
};

const SYMS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];
const PX: Record<string, [string, string]> = { AAPL: ["232.41", "230.00"], MSFT: ["512.10", "515.00"], GOOGL: ["178.25", "177.00"], AMZN: ["214.60", "214.60"], NVDA: ["186.30", "184.00"], META: ["684.21", "680.00"], TSLA: ["342.80", "345.10"] };

export const tickers: TickersResponse = {
  data: SYMS.map((s) => ({ symbol: s, underlying: { price: PX[s]![0], conf: "0.08", publishTime: "2026-11-25T19:12:02Z" }, prevClose: PX[s]![1], activeMarkets: s === "META" ? 7 : 5, tickerDayStatus: "OPEN" })),
};

export const mkt = (strikeCents: number, yes: [number | null, number | null], extra: Partial<Market> = {}): Market => ({
  marketId: `META-${strikeCents}`, symbol: "META", tradingDate: "2026-11-25", strike: (strikeCents / 100).toFixed(2), strikeCents,
  question: `Will META close at or above $${(strikeCents / 100).toFixed(2)} today?`, status: "TRADING", outcome: null,
  yes: { bid: yes[0], ask: yes[1], last: yes[0] }, no: { bid: yes[1] == null ? null : 100 - yes[1], ask: yes[0] == null ? null : 100 - yes[0] },
  impliedProbability: yes[0] != null && yes[1] != null ? (yes[0] + yes[1]) / 200 : null,
  volume: 18240, pairsOutstanding: 9120, yesMint: "Ye5", noMint: "No5", openTime: "2026-11-25T14:30:00Z", closeTime: "2026-11-25T21:00:00Z", closeTimeUnix: CLOSE_UNIX, seq: "88231",
  ...extra,
});

export const metaMarkets: MarketsResponse = {
  symbol: "META", tradingDate: "2026-11-25", closeTime: "2026-11-25T21:00:00Z", closeTimeUnix: CLOSE_UNIX,
  markets: [mkt(65000, [96, 98]), mkt(66000, [90, 93]), mkt(67000, [80, 83]), mkt(68000, [61, 64]), mkt(69000, [33, 36]), mkt(70000, [10, 13]), mkt(71000, [2, 4])],
};

export const bookYes: BookSnapshot = { marketId: "META-68000", seq: "88231", view: "YES", bids: [[61, 1200], [60, 800]], asks: [[64, 500], [65, 2200]], updatedAt: "2026-11-25T19:12:03.114Z" };

export const settlements: Settlements = {
  tradingDate: "2026-11-25",
  tickers: [{ symbol: "META", status: "FINAL", closePrice: "685.12", publishTime: "2026-11-25T21:00:01Z", finalAt: null, markets: [
    { marketId: "META-68000", strike: "680.00", strikeCents: 68000, outcome: "YES", provisional: false, status: "SETTLED" },
    { marketId: "META-70000", strike: "700.00", strikeCents: 70000, outcome: "NO", provisional: false, status: "SETTLED" },
  ] }],
};

export const pos = (p: Partial<Position>): Position => ({
  marketId: "META-68000", symbol: "META", strike: "680.00", side: "YES", qty: 150, yesQty: 150, noQty: 0, avgEntryCents: 58.4, markCents: 63,
  unrealizedPnl: "6900000", realizedPnl: "0", status: "TRADING", outcome: null, payoutIfWin: "150000000", redeemable: "0", redeemed: false,
  ledger: { freeUsdc: "0", freeYes: 0 }, ...p,
});

export const history: HistoryItem[] = [
  { time: "2026-11-25T18:01:44Z", marketId: "META-68000", intent: "BUY_NO", qty: 100, priceCents: 37, fee: "0", usdc: null, signature: "5HkSigBuyNo1111111111111111111111111111111111" },
  { time: "2026-11-25T17:30:00Z", marketId: "META-68000", intent: "SELL_YES", qty: 40, priceCents: 62, fee: "124000", usdc: null, signature: "3xSigSellYes111111111111111111111111111111111" },
  { time: "2026-11-25T16:00:00Z", marketId: "META-70000", intent: "REDEEM", qty: 20, priceCents: null, fee: "0", usdc: "20000000", signature: "9RdSigRedeem111111111111111111111111111111111" },
];
