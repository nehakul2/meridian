/** MER-75 · FE-12, CAL-08: countdown on the server clock, half days, phase banner, history by intent. */
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Countdown, PhaseBanner } from "@/components/Countdown";
import { HistoryView } from "@/components/History";
import { formatCountdown, offsetFrom } from "@/lib/clock";
import type { Phase, Status } from "@/lib/types";
import { CLOSE_UNIX, history, status } from "./fixtures";
import { OWNER, renderWith } from "./helpers";

const withStatus = (s: Partial<Status>) => ({ api: { status: vi.fn(async () => ({ ...status, ...s, receivedAt: Date.now(), rttMs: 0 })) } });

describe("server clock (R7.3)", () => {
  it("offset is serverTime minus the local time at the middle of the round trip", () => {
    expect(offsetFrom("2026-11-25T19:12:03.000Z", Date.parse("2026-11-25T19:12:10.000Z"), 200)).toBe(-6_900);
  });

  it("formats hours, minutes and seconds", () => {
    expect(formatCountdown(6_477_000)).toBe("1h 47m 57s");
    expect(formatCountdown(65_000)).toBe("1m 05s");
    expect(formatCountdown(4_000)).toBe("4s");
    expect(formatCountdown(-1)).toBe("0s");
  });
});

describe("Countdown (MER-75)", () => {
  it("counts to close_time on serverTime, ignoring a skewed client clock (FE-12)", async () => {
    // The test machine's clock is days away from the fixture's serverTime; only the offset matters.
    renderWith(<Countdown closeTimeUnix={CLOSE_UNIX} />);
    await waitFor(() => expect(screen.getByTestId("countdown").textContent).toMatch(/^Closes in 1h 47m 5[67]s$/));
  });

  it("handles a half day: 1:00 PM ET close (CAL-08)", async () => {
    const half = Date.parse("2026-11-27T18:00:00Z") / 1000;
    renderWith(<><Countdown closeTimeUnix={half} /><PhaseBanner /></>, withStatus({ tradingDate: "2026-11-27", closeTime: "2026-11-27T18:00:00Z", closeTimeUnix: half, openTime: "2026-11-27T14:30:00Z", serverTime: "2026-11-27T17:30:00Z" }));
    await waitFor(() => expect(screen.getAllByTestId("countdown")[0]!.textContent).toMatch(/^Closes in (30m 00s|29m 59s)$/));
    expect(screen.getByTestId("phase-banner").textContent).toContain("open until 1:00 PM ET");
  });

  it("shows Closed once server time passes the close", async () => {
    renderWith(<Countdown closeTimeUnix={CLOSE_UNIX} />, withStatus({ serverTime: "2026-11-25T21:00:05Z" }));
    await waitFor(() => expect(screen.getByTestId("countdown").textContent).toBe("Closed"));
  });

  it("renders nothing until the server clock is known", () => {
    renderWith(<Countdown closeTimeUnix={CLOSE_UNIX} />, { api: { status: vi.fn(() => new Promise<never>(() => undefined)) } });
    expect(screen.queryByTestId("countdown")).toBeNull();
  });
});

describe("PhaseBanner (MER-75)", () => {
  const titles: [Phase, string][] = [
    ["PRE_OPEN", "Pre-open"], ["MINT_ONLY", "Minting only"], ["TRADING", "Trading"], ["HALTED", "Trading closed"],
    ["SETTLING", "Settling"], ["PROVISIONAL", "Provisional"], ["DISPUTED", "Disputed"], ["SETTLED", "Settled"], ["CLOSED_DAY", "Market closed"],
  ];
  for (const [phase, title] of titles) {
    it(`${phase} shows "${title}"`, async () => {
      renderWith(<PhaseBanner />, withStatus({ phase }));
      const b = await screen.findByTestId("phase-banner");
      expect(b.getAttribute("data-phase")).toBe(phase);
      expect(b.textContent).toContain(`${title}.`);
    });
  }

  it("paused overrides the phase", async () => {
    renderWith(<PhaseBanner />, withStatus({ paused: true }));
    const b = await screen.findByTestId("phase-banner");
    expect(b.getAttribute("data-phase")).toBe("PAUSED");
    expect(b.textContent).toContain("Cancels, merges, claims and redemptions still work");
  });
});

describe("History (MER-75)", () => {
  it("lists executions by intent with explorer links, never the raw book side", async () => {
    sessionStorage.setItem(`meridian.jwt.${OWNER.publicKey.toBase58()}`, JSON.stringify({ token: "jwt-stored", exp: 4102444800 }));
    renderWith(<HistoryView />, { api: { history: vi.fn(async () => ({ data: history, nextBefore: null })) } });
    const t = await screen.findByTestId("history-table");
    const rows = within(t).getAllByTestId("history-row");
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => within(r).getByTestId("intent").textContent)).toEqual(["Bought No", "Sold Yes", "Redeemed"]);
    expect(t.textContent).not.toMatch(/\b(BID|ASK)\b/);
    expect(rows[0]!.textContent).toContain("37¢ No");
    expect(rows[0]!.textContent).toContain("$37.00"); // 100 × 37¢
    expect(rows[1]!.textContent).toContain("$0.12"); // fee
    expect(rows[1]!.textContent).toContain("$24.67"); // 40 × 62¢ − fee
    expect(rows[2]!.textContent).toContain("$20.00");
    await waitFor(() => expect(rows[0]!.textContent).toContain("META ≥ $680.00"));
    const link = within(rows[0]!).getByTestId("sig-link");
    expect(link.getAttribute("href")).toBe(`https://explorer.solana.com/tx/${history[0]!.signature}?cluster=devnet`);
  });
});
