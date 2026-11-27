/** MER-74 · FE-07, FE-08, FE-11, POS-05: P&L, settlement display, redeem batches, claim, maker view. */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PortfolioView } from "@/components/Portfolio";
import type { Claimable, Order, Position } from "@/lib/types";
import { pos } from "./fixtures";
import { fakeWallet, OWNER, renderWith, UNSIGNED_TX } from "./helpers";

const owner = OWNER.publicKey.toBase58();
const signedIn = () => sessionStorage.setItem(`meridian.jwt.${owner}`, JSON.stringify({ token: "jwt-stored", exp: 4102444800 }));

const open: Position[] = [
  pos({}),
  pos({ marketId: "META-70000", strike: "700.00", side: "NO", qty: 80, yesQty: 0, noQty: 80, avgEntryCents: 42, markCents: 88.5, unrealizedPnl: "37200000", realizedPnl: "4200000" }),
  pos({ marketId: "META-69000", strike: "690.00", side: "BOTH_PENDING", qty: 40, yesQty: 40, noQty: 40, avgEntryCents: 100, markCents: 65, unrealizedPnl: "-14000000" }),
];
const winner = pos({ marketId: "META-67000", strike: "670.00", status: "SETTLED", outcome: "YES", side: "YES", qty: 50, yesQty: 50, markCents: 100, unrealizedPnl: "19000000", redeemable: "50000000" });
const loser = pos({ marketId: "META-71000", strike: "710.00", status: "SETTLED", outcome: "YES", side: "NO", qty: 60, yesQty: 0, noQty: 60, markCents: 0, unrealizedPnl: "-27600000", redeemable: "0" });
const noClaims: Claimable = { data: [], totals: { ledgerUsdc: "0", redeemable: "50000000" } };

function setupPortfolio(o: { positions?: Position[]; claimable?: Claimable; orders?: Order[] } = {}) {
  signedIn();
  const positions = o.positions ?? [...open, winner, loser];
  return renderWith(<PortfolioView />, {
    api: {
      positions: vi.fn(async () => ({ data: positions })),
      claimable: vi.fn(async () => o.claimable ?? noClaims),
      orders: vi.fn(async () => ({ data: o.orders ?? [] })),
      market: vi.fn(async (id: string) => ({ ...(await import("./fixtures")).mkt(Number(id.split("-")[1]), [null, null]), status: "SETTLED" as const })),
      settlements: vi.fn(async () => ({ tradingDate: "2026-11-25", tickers: [{ symbol: "META", status: "FINAL", closePrice: "685.12", publishTime: null, finalAt: null, markets: [
        { marketId: "META-67000", strike: "670.00", strikeCents: 67000, outcome: "YES" as const, provisional: false, status: "SETTLED" },
        { marketId: "META-71000", strike: "710.00", strikeCents: 71000, outcome: "YES" as const, provisional: false, status: "SETTLED" },
      ] }] })),
    },
  });
}

describe("Portfolio (MER-74)", () => {
  it("asks to sign in first, once, on this user-scoped page", async () => {
    const h = renderWith(<PortfolioView />);
    await waitFor(() => expect(h.wallet.signMessage).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/No open positions/)).toBeTruthy();
    expect(h.wallet.signMessage).toHaveBeenCalledTimes(1);
  });

  it("P&L values match the API fixture (FE-07)", async () => {
    setupPortfolio();
    const t = await screen.findByTestId("open-positions");
    const meta = within(t).getByTestId("pos-META-68000");
    expect(within(meta).getByTestId("unrealized").textContent).toBe("+$6.90");
    expect(meta.textContent).toContain("58.4¢");
    expect(meta.textContent).toContain("63¢");
    expect(meta.textContent).toContain("$150.00");
    const no = within(t).getByTestId("pos-META-70000");
    expect(within(no).getByTestId("unrealized").textContent).toBe("+$37.20");
    expect(no.textContent).toContain("+$4.20");
    expect(no.textContent).toContain("88.5¢");
    // Totals: open unrealized 6.90 + 37.20 − 14.00.
    expect(screen.getByTestId("total-unrealized").textContent).toBe("+$30.10");
  });

  it("labels a resting Buy No limit as BOTH_PENDING (POS-05)", async () => {
    setupPortfolio();
    const row = await screen.findByTestId("pos-META-69000");
    expect(within(row).getByTestId("side").textContent).toBe("Buy No pending");
    expect(within(row).getByTestId("unrealized").textContent).toBe("-$14.00");
  });

  it("settled winner shows the close, $1.00 a token and redeem; loser shows $0.00 (FE-08)", async () => {
    setupPortfolio();
    const w = await screen.findByTestId("settled-META-67000");
    await waitFor(() => expect(within(w).getByTestId("close-price").textContent).toBe("$685.12"));
    expect(within(w).getByTestId("per-token").textContent).toBe("$1.00");
    expect(w.textContent).toContain("$50.00");
    expect(within(w).getByText("Redeemable")).toBeTruthy();
    const l = screen.getByTestId("settled-META-71000");
    expect(within(l).getByTestId("per-token").textContent).toBe("$0.00");
    expect(screen.getByTestId("redeem")).toBeTruthy();
  });

  it("redeem sends every winner in one request and signs one transaction per batch it returns", async () => {
    const many = Array.from({ length: 8 }, (_, i) => pos({ marketId: `META-${60000 + i * 100}`, status: "SETTLED", outcome: "YES", side: "YES", redeemable: "1000000" }));
    const h = setupPortfolio({ positions: many });
    h.api.txRedeem.mockResolvedValue({ transaction: UNSIGNED_TX, transactions: [UNSIGNED_TX, UNSIGNED_TX], lastValidBlockHeight: 9, summary: { copy: "You receive $8.00." }, warnings: ["SPLIT_INTO_MULTIPLE_TXS"] });
    fireEvent.click(await screen.findByTestId("redeem"));
    await waitFor(() => expect(h.rpc.sendRaw).toHaveBeenCalledTimes(2));
    expect(h.api.txRedeem).toHaveBeenCalledTimes(1);
    expect(h.api.txRedeem.mock.calls[0]![0].marketIds).toHaveLength(8);
    expect(h.wallet.signTransaction).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByTestId("tx-status").getAttribute("data-state")).toBe("confirmed"));
  });

  it("a losing position offers Clear, which redeems it for $0.00", async () => {
    const h = setupPortfolio();
    const l = await screen.findByTestId("settled-META-71000");
    fireEvent.click(within(l).getByTestId("clear"));
    await waitFor(() => expect(h.api.txRedeem).toHaveBeenCalledWith({ owner, marketIds: ["META-71000"] }));
  });

  it("claim appears only with a ledger balance (FE-11)", async () => {
    setupPortfolio();
    await screen.findByTestId("open-positions");
    expect(screen.queryByTestId("claim")).toBeNull();
  });

  it("claim withdraws each market's ledger proceeds", async () => {
    const claimable: Claimable = {
      data: [
        { marketId: "META-68000", symbol: "META", strike: "680.00", status: "TRADING", ledger: { freeUsdc: "12400000", freeYes: 0 }, redeemable: "0" },
        { marketId: "META-67000", symbol: "META", strike: "670.00", status: "SETTLED", ledger: { freeUsdc: "0", freeYes: 0 }, redeemable: "50000000" },
      ],
      totals: { ledgerUsdc: "12400000", redeemable: "50000000" },
    };
    const h = setupPortfolio({ claimable });
    const btn = await screen.findByTestId("claim");
    expect(btn.textContent).toBe("Claim $12.40");
    fireEvent.click(btn);
    await waitFor(() => expect(h.api.txWithdraw).toHaveBeenCalledWith({ owner, marketId: "META-68000" }));
    expect(h.api.txWithdraw).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId("tx-status").getAttribute("data-state")).toBe("confirmed"));
  });

  it("maker view shows resting exposure, order fills and P&L", async () => {
    const orders: Order[] = [
      { marketId: "META-68000", orderId: "1", intent: "BUY_YES", bookSide: "BID", yesPriceCents: 60, priceCents: 60, qty: 100, filled: 40, remaining: 60, tif: "GTC", status: "OPEN", placedAt: null, signature: null },
      { marketId: "META-68000", orderId: "2", intent: "SELL_YES", bookSide: "ASK", yesPriceCents: 66, priceCents: 66, qty: 50, filled: 0, remaining: 50, tif: "GTC", status: "OPEN", placedAt: null, signature: null },
    ];
    setupPortfolio({ orders });
    fireEvent.click(await screen.findByTestId("maker-tab"));
    const v = await screen.findByTestId("maker-view");
    await waitFor(() => expect(v.textContent).toContain("$36.00")); // 60 × 60¢ at risk on the bid
    expect(v.textContent).toContain("META ≥ $680.00");
    expect(v.textContent).toContain("40/100");
    // P&L = realized 4.20 + unrealized (6.90 + 37.20 − 14.00 + 19.00 − 27.60).
    expect(v.textContent).toContain("Total P&L +$25.70");
  });

  it("without a wallet, prompts to connect", () => {
    renderWith(<PortfolioView />, { wallet: fakeWallet({ kp: null }) });
    expect(screen.getByText("Connect a wallet to see your portfolio")).toBeTruthy();
  });
});
