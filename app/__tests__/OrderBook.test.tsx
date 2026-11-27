/** MER-72 · FE-04: one book, Yes and No views, deltas by seq, gap refetch, remembered view. */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { applyDelta, fromSnapshot, levels } from "@/lib/book";
import { useBook } from "@/lib/market-data";
import { OrderBook, useDefaultView } from "@/components/OrderBook";
import { bookYes } from "./fixtures";
import { OWNER, renderWith } from "./helpers";

function BookHarness() {
  const { book } = useBook("META-68000");
  const [view, setView] = useDefaultView();
  return <OrderBook book={book} view={view} onViewChange={setView} />;
}

const signedIn = () => sessionStorage.setItem(`meridian.jwt.${OWNER.publicKey.toBase58()}`, JSON.stringify({ token: "jwt-stored", exp: 4102444800 }));

describe("book model (MER-72)", () => {
  it("No view levels are the inverse of the Yes fixture", () => {
    const b = fromSnapshot(bookYes);
    expect(levels(b, "YES")).toEqual({ bids: [[61, 1200], [60, 800]], asks: [[64, 500], [65, 2200]] });
    // No bids from Yes asks at 100 − p; No asks from Yes bids at 100 − p (A19).
    expect(levels(b, "NO")).toEqual({ bids: [[36, 500], [35, 2200]], asks: [[39, 1200], [40, 800]] });
  });

  it("applies deltas by seq; stale ones are ignored; a broken chain is a gap", () => {
    const b = fromSnapshot(bookYes);
    const r = applyDelta(b, { type: "book_delta", seq: "88232", prev_seq: "88231", changes: [["B", 62, 300], ["A", 64, 0]] });
    expect(r.kind).toBe("applied");
    if (r.kind !== "applied") return;
    expect(levels(r.book, "YES").bids[0]).toEqual([62, 300]);
    expect(levels(r.book, "YES").asks[0]).toEqual([65, 2200]);
    expect(applyDelta(r.book, { type: "book_delta", seq: "88232", prev_seq: "88231", changes: [["B", 1, 1]] }).kind).toBe("stale");
    expect(applyDelta(r.book, { type: "book_delta", seq: "88240", prev_seq: "88239", changes: [] }).kind).toBe("gap");
  });
});

describe("OrderBook component (MER-72)", () => {
  it("renders the Yes view and the No view of the same snapshot", async () => {
    renderWith(<BookHarness />);
    await screen.findByTestId("bid-61");
    expect(screen.getByTestId("order-book").getAttribute("data-view")).toBe("YES");
    expect(screen.getByTestId("ask-64").textContent).toContain("500");
    fireEvent.click(screen.getByRole("button", { name: "No view" }));
    expect(screen.getByTestId("order-book").getAttribute("data-view")).toBe("NO");
    expect(screen.getByTestId("bid-36").textContent).toContain("500");
    expect(screen.getByTestId("ask-39").textContent).toContain("1,200");
    expect(screen.getByText("No price")).toBeTruthy();
    expect(screen.getByTestId("book-seq").textContent).toBe("seq 88231");
  });

  it("a delta updates both views", async () => {
    const h = renderWith(<BookHarness />);
    await screen.findByTestId("bid-61");
    act(() => h.rt.emit("book:META-68000", { type: "book_delta", seq: "88232", prev_seq: "88231", changes: [["B", 62, 300]] }));
    expect((await screen.findByTestId("bid-62")).textContent).toContain("300");
    fireEvent.click(screen.getByRole("button", { name: "No view" }));
    expect(screen.getByTestId("ask-38").textContent).toContain("300");
    expect(screen.getByTestId("book-seq").textContent).toBe("seq 88232");
  });

  it("ignores an out-of-order delta", async () => {
    const h = renderWith(<BookHarness />);
    await screen.findByTestId("bid-61");
    act(() => h.rt.emit("book:META-68000", { type: "book_delta", seq: "88232", prev_seq: "88231", changes: [["B", 62, 300]] }));
    await screen.findByTestId("bid-62");
    act(() => h.rt.emit("book:META-68000", { type: "book_delta", seq: "88230", prev_seq: "88229", changes: [["B", 62, 0], ["B", 50, 9]] }));
    expect(screen.getByTestId("bid-62")).toBeTruthy();
    expect(screen.queryByTestId("bid-50")).toBeNull();
    expect(screen.getByTestId("book-seq").textContent).toBe("seq 88232");
  });

  it("a seq gap triggers a snapshot refetch", async () => {
    const h = renderWith(<BookHarness />);
    await screen.findByTestId("bid-61");
    expect(h.api.book).toHaveBeenCalledTimes(1);
    h.api.book.mockResolvedValueOnce({ ...bookYes, seq: "88300", bids: [[63, 10]], asks: [[66, 20]] });
    act(() => h.rt.emit("book:META-68000", { type: "book_delta", seq: "88299", prev_seq: "88298", changes: [["B", 1, 1]] }));
    await waitFor(() => expect(h.api.book).toHaveBeenCalledTimes(2));
    expect(h.rt.snapshots).toEqual(["book:META-68000"]);
    expect(await screen.findByTestId("bid-63")).toBeTruthy();
    expect(screen.queryByTestId("bid-1")).toBeNull();
    expect(screen.getByTestId("book-seq").textContent).toBe("seq 88300");
  });

  it("a gateway snapshot replaces the book", async () => {
    const h = renderWith(<BookHarness />);
    await screen.findByTestId("bid-61");
    act(() => h.rt.emit("book:META-68000", { type: "book_snapshot", seq: "90000", bids: [[55, 5]], asks: [[57, 6]] }));
    expect(await screen.findByTestId("bid-55")).toBeTruthy();
    expect(screen.queryByTestId("bid-61")).toBeNull();
  });

  it("starts in the user's saved default view and saves a change to user_prefs", async () => {
    signedIn();
    const h = renderWith(<BookHarness />, { api: { prefs: vi.fn(async () => ({ defaultView: "NO" as const, slippageCents: 3 })) } });
    await waitFor(() => expect(screen.getByTestId("order-book").getAttribute("data-view")).toBe("NO"));
    fireEvent.click(screen.getByRole("button", { name: "Yes view" }));
    await waitFor(() => expect(h.api.putPrefs).toHaveBeenCalledWith(expect.any(Function), { defaultView: "YES" }));
    expect(localStorage.getItem("meridian.defaultView")).toBe("YES");
  });

  it("signed out, the choice is remembered in this browser only", async () => {
    localStorage.setItem("meridian.defaultView", "NO");
    const h = renderWith(<BookHarness />);
    await screen.findByTestId("bid-36");
    fireEvent.click(screen.getByRole("button", { name: "Yes view" }));
    expect(localStorage.getItem("meridian.defaultView")).toBe("YES");
    expect(h.api.putPrefs).not.toHaveBeenCalled();
  });
});
