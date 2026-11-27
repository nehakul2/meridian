/**
 * MER-73 · FE-02, FE-03, FE-06, FE-09, POS-04, POS-07, HLT-05, PSE-06: the four intents, the
 * position guard, the builder's copy, signing outcomes and the disabled states.
 */
import { WalletSignTransactionError } from "@solana/wallet-adapter-base";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { Intent, Position, TradeRequest } from "@/lib/types";
import { guardFor, TradePanel, worstPrice } from "@/components/TradePanel";
import { mkt, pos, status } from "./fixtures";
import { fakeWallet, OWNER, renderWith, unsignedTx } from "./helpers";

const market = mkt(68000, [61, 64]); // Yes 61/64, No 36/39
const owner = OWNER.publicKey.toBase58();
const signedIn = () => sessionStorage.setItem(`meridian.jwt.${owner}`, JSON.stringify({ token: "jwt-stored", exp: 4102444800 }));

function lastTrade(api: { txTrade: { mock: { calls: unknown[][] } } }): TradeRequest {
  return api.txTrade.mock.calls.at(-1)![0] as TradeRequest;
}

describe("worst price and guard rules", () => {
  it("market orders use best ± slippage, clamped to 1..99 (A18)", () => {
    expect(worstPrice("BUY_YES", 64, 2)).toBe(66);
    expect(worstPrice("SELL_YES", 61, 2)).toBe(59);
    expect(worstPrice("BUY_NO", 98, 3)).toBe(99);
    expect(worstPrice("SELL_NO", 2, 3)).toBe(1);
    expect(worstPrice("BUY_YES", null, 2)).toBeNull();
  });

  it("guard per holding (POS-04, POS-07)", () => {
    const no = pos({ side: "NO", qty: 80, yesQty: 0, noQty: 80 });
    const yes = pos({ side: "YES", qty: 150, yesQty: 150, noQty: 0 });
    const pending = pos({ side: "BOTH_PENDING", qty: 40, yesQty: 40, noQty: 40 });
    expect(guardFor("BUY_YES", no)).toMatchObject({ blocked: true, action: { label: "Sell No first", intent: "SELL_NO", qty: 80 } });
    expect(guardFor("BUY_NO", no).blocked).toBe(false);
    expect(guardFor("BUY_NO", yes)).toMatchObject({ blocked: true, action: { label: "Sell Yes first", intent: "SELL_YES", qty: 150 } });
    expect(guardFor("BUY_YES", yes).blocked).toBe(false);
    expect(guardFor("BUY_YES", pending)).toMatchObject({ blocked: true, action: { cancel: true } });
    expect(guardFor("BUY_NO", pending).blocked).toBe(false);
    expect(guardFor("SELL_YES", null).blocked).toBe(true);
    expect(guardFor("SELL_NO", undefined).blocked).toBe(false); // unknown: the builder decides
  });
});

describe("TradePanel (MER-73)", () => {
  const cases: [Intent, number][] = [["BUY_YES", 66], ["SELL_YES", 59], ["BUY_NO", 41], ["SELL_NO", 34]];
  for (const [intent, worst] of cases) {
    it(`${intent} market posts the intent with worst price ${worst}¢ (FE-02)`, async () => {
      const h = renderWith(<TradePanel market={market} position={undefined} initialIntent={intent} />);
      await waitFor(() => expect(h.api.txTrade).toHaveBeenCalled());
      expect(lastTrade(h.api)).toEqual({ owner, marketId: "META-68000", intent, orderType: "MARKET", qty: 10, priceCents: worst });
    });
  }

  it("limit orders send the typed price in the intent's own terms", async () => {
    const h = renderWith(<TradePanel market={market} position={undefined} initialIntent="BUY_NO" />);
    fireEvent.click(screen.getByRole("button", { name: "Limit" }));
    fireEvent.change(screen.getByTestId("limit-price"), { target: { value: "35" } });
    fireEvent.change(screen.getByTestId("qty"), { target: { value: "100" } });
    await waitFor(() => expect(lastTrade(h.api)).toMatchObject({ intent: "BUY_NO", orderType: "LIMIT", qty: 100, priceCents: 35 }));
  });

  it("uses the slippage from prefs", async () => {
    const h = renderWith(<TradePanel market={market} position={undefined} slippageCents={5} />);
    await waitFor(() => expect(lastTrade(h.api).priceCents).toBe(69));
    expect(screen.getByTestId("worst-price").textContent).toContain("best 64¢ + 5¢ slippage");
  });

  it("shows the builder's summary.copy verbatim (FE-09)", async () => {
    const copy = "You pay up to $6.60. You win $10.00 if META closes at or above $680.00.";
    renderWith(<TradePanel market={market} position={null} />, {
      api: { txTrade: vi.fn(async () => ({ transaction: unsignedTx(), lastValidBlockHeight: 1, summary: { copy, maxCost: "6600000", payoutIfWin: "10000000" }, warnings: [] })) },
    });
    expect((await screen.findByTestId("summary-copy")).textContent).toBe(copy);
    expect(screen.getByText("$6.60")).toBeTruthy();
  });

  it("holding No disables Buy Yes with a Sell No first action (POS-04)", async () => {
    const p: Position = pos({ side: "NO", qty: 80, yesQty: 0, noQty: 80 });
    const h = renderWith(<TradePanel market={market} position={p} initialIntent="BUY_YES" />);
    const g = await screen.findByTestId("guard");
    expect(g.textContent).toContain("You hold 80 No");
    expect((screen.getByTestId("submit") as HTMLButtonElement).disabled).toBe(true);
    expect(h.api.txTrade).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("guard-action"));
    expect(screen.getByTestId("intent-SELL_NO").getAttribute("aria-selected")).toBe("true");
    expect((screen.getByTestId("qty") as HTMLInputElement).value).toBe("80");
    await waitFor(() => expect(lastTrade(h.api)).toMatchObject({ intent: "SELL_NO", qty: 80, priceCents: 34 }));
  });

  it("holding Yes disables Buy No with a Sell Yes first action", async () => {
    renderWith(<TradePanel market={market} position={pos({})} initialIntent="BUY_NO" />);
    expect((await screen.findByTestId("guard")).textContent).toContain("You hold 150 Yes");
    expect(screen.getByTestId("guard-action").textContent).toBe("Sell Yes first");
  });

  it("a resting Buy No blocks Buy Yes until it is cancelled", async () => {
    const h = renderWith(<TradePanel market={market} position={pos({ side: "BOTH_PENDING", qty: 40, yesQty: 40, noQty: 40 })} initialIntent="BUY_YES" />);
    fireEvent.click(await screen.findByTestId("guard-action"));
    await waitFor(() => expect(h.api.txCancel).toHaveBeenCalledWith({ owner, marketId: "META-68000", all: true }));
  });

  it("a 409 from the builder shows its requiredAction (POS-07, stale local state)", async () => {
    const err = new ApiError("POSITION_CONFLICT", "Sell your No first", 409, { requiredAction: "SELL_NO", yes: 0, no: 25 });
    renderWith(<TradePanel market={market} position={undefined} />, { api: { txTrade: vi.fn(async () => { throw err; }) } });
    const g = await screen.findByTestId("guard");
    expect(g.textContent).toContain("Sell your No first");
    fireEvent.click(screen.getByTestId("guard-action"));
    expect(screen.getByTestId("intent-SELL_NO").getAttribute("aria-selected")).toBe("true");
    expect((screen.getByTestId("qty") as HTMLInputElement).value).toBe("25");
  });

  it("an order over the size cap shows the builder's message", async () => {
    const err = new ApiError("ORDER_TOO_LARGE", "At most 500 contracts per trade; reduce the size or split the order", 422, { maxQty: 500 });
    renderWith(<TradePanel market={market} position={null} />, { api: { txTrade: vi.fn(async () => { throw err; }) } });
    expect((await screen.findByTestId("preview-error")).textContent).toContain("At most 500 contracts");
  });

  it("signs, sends and confirms; a partial fill is reported (FE-02, FE-06)", async () => {
    signedIn();
    const h = renderWith(<TradePanel market={market} position={null} />, {
      api: { txTrade: vi.fn(async () => ({ transaction: unsignedTx(), lastValidBlockHeight: 1, summary: { copy: "c", maxCost: "1", payoutIfWin: "1" }, warnings: ["PARTIAL_FILL_LIKELY"] })) },
    });
    fireEvent.change(screen.getByTestId("qty"), { target: { value: "100" } });
    expect(await screen.findByTestId("partial-warning")).toBeTruthy();
    await waitFor(() => expect((screen.getByTestId("submit") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("submit"));
    await waitFor(() => expect(screen.getByTestId("tx-status").getAttribute("data-state")).toBe("confirmed"));
    expect(h.wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(h.rpc.sendRaw).toHaveBeenCalledTimes(1);
    expect(h.rpc.confirm).toHaveBeenCalledWith("5igSig", 1);
    act(() => h.rt.emit("user", { type: "fill", market: "META-68000", qty: 60, price: 64, sig: "5igSig" }));
    expect((await screen.findByTestId("partial-fill")).textContent).toBe("Filled 60 of 100; the rest was cancelled.");
  });

  it("a wallet rejection is reported and nothing is sent (FE-03)", async () => {
    const signTransaction = vi.fn(async () => { throw new WalletSignTransactionError("User rejected the request."); });
    const h = renderWith(<TradePanel market={market} position={null} />, { wallet: fakeWallet({ signTransaction: signTransaction as never }) });
    await waitFor(() => expect((screen.getByTestId("submit") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("submit"));
    const s = await screen.findByTestId("tx-status");
    expect(s.getAttribute("data-state")).toBe("rejected");
    expect(s.textContent).toContain("Transaction cancelled");
    expect(s.textContent).toContain("nothing was sent");
    expect(h.rpc.sendRaw).not.toHaveBeenCalled();
  });

  it("a failed transaction shows the program error", async () => {
    renderWith(<TradePanel market={market} position={null} />, { rpc: { confirm: vi.fn(async () => ({ status: "failed" as const, error: '{"InstructionError":[1,{"Custom":6012}]}' })) } });
    await waitFor(() => expect((screen.getByTestId("submit") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("submit"));
    await waitFor(() => expect(screen.getByTestId("tx-status").getAttribute("data-state")).toBe("failed"));
    expect(screen.getByTestId("tx-status").textContent).toContain("Custom");
  });

  it("is disabled after close_time with the reason (HLT-05)", async () => {
    // Server time 19:12 Z; this market closed at 19:00 Z. The client clock is days ahead and must not matter.
    const closed = mkt(68000, [61, 64], { closeTimeUnix: Date.parse("2026-11-25T19:00:00Z") / 1000 });
    const h = renderWith(<TradePanel market={closed} position={null} />);
    expect((await screen.findByTestId("trade-disabled")).textContent).toContain("Trading closed at 2:00 PM ET");
    expect((screen.getByTestId("submit") as HTMLButtonElement).disabled).toBe(true);
    expect(h.api.txTrade).not.toHaveBeenCalled();
  });

  it("stays open before close_time even if the client clock is past it", async () => {
    const h = renderWith(<TradePanel market={market} position={null} />);
    await waitFor(() => expect(h.api.txTrade).toHaveBeenCalled());
    expect(screen.queryByTestId("trade-disabled")).toBeNull();
  });

  it("is disabled when halted", async () => {
    renderWith(<TradePanel market={mkt(68000, [61, 64], { status: "HALTED" })} position={null} />);
    expect((await screen.findByTestId("trade-disabled")).textContent).toContain("Trading closed");
  });

  it("is disabled when paused, and re-enabled on unpause from the sys channel (PSE-06)", async () => {
    const h = renderWith(<TradePanel market={market} position={null} />, { api: { status: vi.fn(async () => ({ ...status, paused: true, receivedAt: Date.now(), rttMs: 0 })) } });
    expect((await screen.findByTestId("trade-disabled")).textContent).toContain("paused");
    act(() => h.rt.emit("sys", { type: "unpaused" }));
    await waitFor(() => expect(screen.queryByTestId("trade-disabled")).toBeNull());
  });

  it("market order with an empty side shows no liquidity", async () => {
    renderWith(<TradePanel market={mkt(68000, [61, null])} position={null} initialIntent="BUY_YES" />);
    expect(screen.getByTestId("worst-price").textContent).toContain("No liquidity");
    expect((screen.getByTestId("submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("without a wallet, asks to connect and explains the payoff", () => {
    renderWith(<TradePanel market={market} position={undefined} initialIntent="BUY_NO" />, { wallet: fakeWallet({ kp: null }) });
    expect(screen.getByTestId("submit").textContent).toBe("Connect a wallet to trade");
    expect(screen.getByTestId("payoff").textContent).toContain("closes below $680.00");
  });
});
