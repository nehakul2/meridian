/** MER-71 · FE-05, FE-10: tickers with live prices, contract cards from the API and the live book. */
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContractCard, StrikeLadder, TickerGrid } from "@/components/Markets";
import { pct } from "@/lib/format";
import { metaMarkets, mkt, tickers } from "./fixtures";
import { renderWith } from "./helpers";

/** Each market's book snapshot from its fixture quotes. */
const bookFor = vi.fn(async (id: string) => {
  const m = metaMarkets.markets.find((x) => x.marketId === id)!;
  return { marketId: id, seq: "100", view: "YES" as const, bids: [[m.yes.bid!, 500]] as [number, number][], asks: [[m.yes.ask!, 400]] as [number, number][], updatedAt: null };
});

describe("TickerGrid (MER-71)", () => {
  it("renders the 7 tickers with price and active contract count", async () => {
    renderWith(<TickerGrid />);
    const grid = await screen.findByTestId("ticker-grid");
    for (const t of tickers.data) expect(within(grid).getByTestId(`ticker-${t.symbol}`)).toBeTruthy();
    expect(grid.querySelectorAll(".ticker-card")).toHaveLength(7);
    expect(screen.getByTestId("px-META").textContent).toBe("$684.21");
    expect(within(screen.getByTestId("ticker-META")).getByText("7 contracts")).toBeTruthy();
    expect(within(screen.getByTestId("ticker-META")).getByText("+4.21 (+0.62%)")).toBeTruthy();
  });

  it("re-renders on a live px update (FE-05)", async () => {
    const h = renderWith(<TickerGrid />);
    await screen.findByTestId("ticker-grid");
    expect(h.rt.subs.has("px:META")).toBe(true);
    act(() => h.rt.emit("px:META", { type: "underlying", price: "690.55", conf: "0.05", publish_time: 1764098000 }));
    await waitFor(() => expect(screen.getByTestId("px-META").textContent).toBe("$690.55"));
  });

  it("shows the publish time, and flags a price older than 60 s on the server clock (FE-05)", async () => {
    // Server time 19:12:03Z; META published 19:12:02Z (fresh), TSLA at 19:10:00Z (stale).
    renderWith(<TickerGrid />, { api: { tickers: vi.fn(async () => ({ data: tickers.data.map((t) => (t.symbol === "TSLA" ? { ...t, underlying: { ...t.underlying!, publishTime: "2026-11-25T19:10:00Z" } } : t)) })) } });
    await screen.findByTestId("ticker-grid");
    expect(screen.getByTestId("asof-META").textContent).toContain("as of 2:12:02 PM ET");
    await waitFor(() => expect(screen.getByTestId("stale-TSLA")).toBeTruthy());
    expect(screen.queryByTestId("stale-META")).toBeNull();
  });

  it("shows a missing feed instead of a stale number", async () => {
    renderWith(<TickerGrid />, { api: { tickers: vi.fn(async () => ({ data: tickers.data.map((t) => (t.symbol === "TSLA" ? { ...t, underlying: null } : t)) })) } });
    await screen.findByTestId("ticker-grid");
    expect(screen.getByTestId("px-TSLA").textContent).toBe("—");
    expect(within(screen.getByTestId("ticker-TSLA")).getByText("Price feed offline")).toBeTruthy();
  });
});

describe("Contract cards (MER-71)", () => {
  it("numbers match the API fixture: strike, Yes/No prices, implied probability", async () => {
    renderWith(<StrikeLadder symbol="META" />, { api: { book: bookFor } });
    const card = await screen.findByTestId("contract-68000");
    await waitFor(() => expect(within(card).getByTestId("yes-ask").textContent).toBe("64¢"));
    expect(within(card).getByText("$680.00")).toBeTruthy();
    expect(within(card).getByTestId("no-ask").textContent).toBe("39¢"); // 100 − Yes bid 61 (A19)
    expect(within(card).getByTestId("implied").textContent).toBe("63%"); // mid 62.5
    expect(within(card).getByText("Yes bid 61¢ · No bid 36¢")).toBeTruthy();
    expect(screen.getByTestId("contract-grid").children).toHaveLength(7);
  });

  it("copy says \"at or above\"", async () => {
    renderWith(<StrikeLadder symbol="META" />, { api: { book: bookFor } });
    const card = await screen.findByTestId("contract-68000");
    expect(card.textContent).toContain("META closes at or above $680.00");
    expect(screen.getByText(/at or above the strike, otherwise \$1\.00 to No/)).toBeTruthy();
  });

  it("updates prices from the book channel", async () => {
    const h = renderWith(<StrikeLadder symbol="META" />, { api: { book: bookFor } });
    const card = await screen.findByTestId("contract-68000");
    await waitFor(() => expect(within(card).getByTestId("yes-ask").textContent).toBe("64¢"));
    act(() => h.rt.emit("book:META-68000", { type: "book_delta", seq: "101", prev_seq: "100", changes: [["A", 64, 0], ["A", 63, 250], ["B", 62, 100]] }));
    await waitFor(() => expect(within(card).getByTestId("yes-ask").textContent).toBe("63¢"));
    expect(within(card).getByTestId("no-ask").textContent).toBe("38¢");
    expect(within(card).getByTestId("implied").textContent).toBe("63%"); // mid 62.5 again
  });

  it("a settled contract shows its outcome instead of quotes", () => {
    renderWith(<ContractCard m={mkt(68000, [null, null], { status: "SETTLED", outcome: "YES" })} />);
    expect(screen.getByText("Settled")).toBeTruthy();
    expect(screen.queryByTestId("buy-yes")).toBeNull();
  });

  it("links each side to the trade page with the intent", () => {
    renderWith(<ContractCard m={mkt(68000, [61, 64])} />);
    expect(screen.getByTestId("buy-yes").getAttribute("href")).toMatch(/^\/trade\/?\?m=META-68000&intent=BUY_YES$/);
    expect(screen.getByTestId("buy-no").getAttribute("href")).toMatch(/^\/trade\/?\?m=META-68000&intent=BUY_NO$/);
  });
});

describe("implied probability formatting", () => {
  it("whole percent, dash when unknown", () => {
    expect(pct(0.625)).toBe("63%");
    expect(pct(0.97)).toBe("97%");
    expect(pct(0.004)).toBe("0%");
    expect(pct(null)).toBe("—");
  });
});
