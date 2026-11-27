/**
 * MER-76: the `fe` matrix cases in a real browser. The app is the static build; the backend is
 * the stub (dev/stub-server.ts) speaking the Phase 6 REST, Tx Builder, WebSocket and RPC
 * contracts; the wallet is a Wallet Standard test wallet that signs with real ed25519 keys,
 * and the stub rejects any transaction whose signature does not verify.
 */
import { expect, test, type Page } from "@playwright/test";
import { installTestWallet } from "./test-wallet";

const STUB = "http://localhost:8787";

async function stub(path: string, body: unknown = {}) {
  const r = await fetch(`${STUB}${path}`, { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}
async function marketId(symbol: string, strike: number): Promise<string> {
  const r = await fetch(`${STUB}/v1/tickers/${symbol}/markets`).then((x) => x.json());
  return r.markets.find((m: { strikeCents: number }) => m.strikeCents === strike * 100).marketId;
}

async function connect(page: Page, opts: Parameters<typeof installTestWallet>[1] = {}) {
  const w = await installTestWallet(page, opts);
  await page.goto("/");
  // A second tab in the same browser auto-connects to the wallet chosen in the first one.
  const pill = page.getByTestId("wallet-pill");
  const button = page.locator('[data-testid="connect-wallet"]:not([disabled])').first();
  await expect(pill.or(button)).toBeVisible();
  if (!(await pill.isVisible())) {
    await button.click();
    await page.getByRole("dialog", { name: "Connect a wallet" }).getByText("Meridian Test Wallet").click();
  }
  await expect(pill).toBeVisible();
  return w;
}

async function signIn(page: Page) {
  await page.goto("/portfolio/");
  await expect(page.getByTestId("open-positions")).toBeVisible();
}

async function noHorizontalScroll(page: Page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw).toBeLessThanOrEqual(cw);
}

test.beforeEach(async () => {
  await stub("/__stub/reset", { live: false });
});

test.describe("markets", () => {
  test("7 tickers with counts, live underlying price, contract cards (FE-05, FE-10)", async ({ page }) => {
    await page.goto("/markets/?t=META");
    await expect(page.locator(".ticker-card")).toHaveCount(7);
    const api = await fetch(`${STUB}/v1/tickers`).then((r) => r.json());
    for (const t of api.data) await expect(page.getByTestId(`ticker-${t.symbol}`)).toContainText(`${t.activeMarkets} contracts`);
    await expect(page.getByTestId("asof-META")).toContainText("as of");
    await stub("/__stub/px", { symbol: "META", price: 701.23 });
    await expect(page.getByTestId("px-META")).toHaveText("$701.23");
    await expect(page.getByTestId("contract-grid").locator(".contract-card")).toHaveCount(7);
    await expect(page.getByTestId("contract-68000")).toContainText("META closes at or above $680.00");
  });
});

test.describe("wallet", () => {
  test("connect shows address and USDC balance; disconnect clears user data (FE-01)", async ({ page }) => {
    const w = await connect(page);
    const a = w.address();
    await expect(page.getByTestId("wallet-address")).toHaveText(`${a.slice(0, 4)}…${a.slice(-4)}`);
    await expect(page.getByTestId("usdc-balance")).toHaveText("$1,000.00 USDC");
    await signIn(page);
    await page.getByTestId("wallet-pill").click();
    await page.getByRole("menuitem", { name: "Disconnect" }).click();
    await expect(page.getByTestId("connect-wallet").first()).toBeVisible();
    await expect(page.getByText("Connect a wallet to see your portfolio")).toBeVisible();
    await expect(page.getByTestId("open-positions")).toHaveCount(0);
  });

  test("a rejected sign-in shows a retry that works (FE-03)", async ({ page }) => {
    await connect(page);
    await page.evaluate(() => ((window as unknown as { __tw: { reject: { message: boolean } } }).__tw.reject.message = true));
    await page.getByRole("link", { name: "Portfolio" }).click();
    await expect(page.getByTestId("siws-error")).toContainText("declined");
    await page.evaluate(() => ((window as unknown as { __tw: { reject: { message: boolean } } }).__tw.reject.message = false));
    await page.getByTestId("siws-error").getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("open-positions")).toBeVisible();
    await expect(page.getByTestId("siws-error")).toHaveCount(0);
  });

  test("a wallet on another chain gets the devnet warning", async ({ page }) => {
    await connect(page, { chains: ["solana:mainnet"] });
    await expect(page.getByTestId("network-warning")).toContainText("Switch it to Devnet");
  });
});

test.describe("trade", () => {
  test("Buy Yes market: summary from the builder, sign, confirm, balance and history update (FE-02, FE-09)", async ({ page }) => {
    await connect(page);
    await signIn(page);
    const id = await marketId("GOOGL", 180);
    await page.goto(`/trade/?m=${id}&intent=BUY_YES`);
    await page.getByTestId("qty").fill("10");
    const copy = page.getByTestId("summary-copy");
    await expect(copy).toContainText(/^You pay up to \$\d+\.\d\d\. You win \$10\.00 if GOOGL closes at or above \$180\.00\.$/);
    await page.getByTestId("submit").click();
    await expect(page.getByTestId("tx-status")).toHaveAttribute("data-state", "confirmed");
    await expect(page.getByTestId("tx-status")).toContainText("Filled 10.");
    await expect(page.getByTestId("holding")).toContainText("You hold 10 Yes");
    await expect(page.getByTestId("usdc-balance")).not.toHaveText("$1,000.00 USDC");
    const state = await fetch(`${STUB}/__stub/state`).then((r) => r.json());
    expect(state.rejectedSigs).toBe(0);
    await page.goto("/history/");
    await expect(page.getByTestId("history-row").first()).toContainText("Bought Yes");
    await expect(page.getByTestId("history-row").first()).toContainText("GOOGL ≥ $180.00");
  });

  test("Buy No limit at No 35: copy says below, order rests as a pending Buy No (FE-09)", async ({ page }) => {
    await connect(page);
    await signIn(page);
    const id = await marketId("AMZN", 215);
    await page.goto(`/trade/?m=${id}&intent=BUY_NO`);
    await page.getByRole("button", { name: "Limit" }).click();
    await page.getByTestId("limit-price").fill("35");
    await page.getByTestId("qty").fill("50");
    await expect(page.getByTestId("summary-copy")).toHaveText("You pay up to $17.50. You win $50.00 if AMZN closes below $215.00.");
    await page.getByTestId("submit").click();
    await expect(page.getByTestId("tx-status")).toHaveAttribute("data-state", "confirmed");
    await expect(page.getByTestId("my-orders")).toContainText("Buy No");
    await expect(page.getByTestId("my-orders")).toContainText("35¢");
  });

  test("wallet rejection: Transaction cancelled, nothing sent, no stale pending state (FE-03)", async ({ page }) => {
    await connect(page);
    const id = await marketId("GOOGL", 180);
    await page.goto(`/trade/?m=${id}`);
    await expect(page.getByTestId("summary-copy")).toBeVisible();
    await page.evaluate(() => ((window as unknown as { __tw: { reject: { tx: boolean } } }).__tw.reject.tx = true));
    await page.getByTestId("submit").click();
    await expect(page.getByTestId("tx-status")).toHaveAttribute("data-state", "rejected");
    await expect(page.getByTestId("tx-status")).toContainText("Transaction cancelled");
    await expect(page.getByTestId("submit")).toBeEnabled();
    await expect(page.getByTestId("usdc-balance")).toHaveText("$1,000.00 USDC");
  });

  test("both book views of the same book, updating live (FE-04)", async ({ page }) => {
    const id = await marketId("META", 680);
    await page.goto(`/trade/?m=${id}`);
    const yes = await fetch(`${STUB}/v1/markets/${id}/book?view=YES`).then((r) => r.json());
    const [bid, bidQty] = yes.bids[0];
    const [ask, askQty] = yes.asks[0];
    await expect(page.getByTestId(`bid-${bid}`)).toContainText(bidQty.toLocaleString("en-US"));
    await page.getByRole("button", { name: "No view" }).click();
    await expect(page.getByTestId("order-book")).toHaveAttribute("data-view", "NO");
    await expect(page.getByTestId(`ask-${100 - bid}`)).toContainText(bidQty.toLocaleString("en-US"));
    await expect(page.getByTestId(`bid-${100 - ask}`)).toContainText(askQty.toLocaleString("en-US"));
    // A live delta shows up in the No view at 100 − p.
    await stub("/__stub/delta", { marketId: id, delta: { type: "book_delta", seq: String(Number(yes.seq) + 1), prev_seq: yes.seq, changes: [["B", bid, 4321]] } });
    await expect(page.getByTestId(`ask-${100 - bid}`)).toContainText("4,321");
    await page.getByRole("button", { name: "Yes view" }).click();
    await expect(page.getByTestId(`bid-${bid}`)).toContainText("4,321");
  });

  test("a delta with a broken seq chain makes the client refetch the snapshot (FE-04, WS-02 client half)", async ({ page }) => {
    const id = await marketId("META", 680);
    await page.goto(`/trade/?m=${id}`);
    const yes = await fetch(`${STUB}/v1/markets/${id}/book?view=YES`).then((r) => r.json());
    await expect(page.getByTestId("book-seq")).toHaveText(`seq ${yes.seq}`);
    const refetch = page.waitForRequest((r) => r.url().includes(`/v1/markets/${id}/book`));
    await stub("/__stub/delta", { marketId: id, delta: { type: "book_delta", seq: String(Number(yes.seq) + 5), prev_seq: String(Number(yes.seq) + 4), changes: [["B", 1, 999]] } });
    await refetch;
    await expect(page.getByTestId("bid-1")).toHaveCount(0);
  });

  test("position guard: holding No blocks Buy Yes until the No is sold (POS-04, FE-06)", async ({ page }) => {
    await connect(page);
    await signIn(page);
    const id = await marketId("NVDA", 190); // seeded: 80 No
    await page.goto(`/trade/?m=${id}&intent=BUY_YES`);
    await expect(page.getByTestId("guard")).toContainText("You hold 80 No");
    await expect(page.getByTestId("submit")).toBeDisabled();
    await page.getByTestId("guard-action").click();
    await expect(page.getByTestId("intent-SELL_NO")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("qty")).toHaveValue("80");
    await page.getByTestId("submit").click();
    await expect(page.getByTestId("tx-status")).toHaveAttribute("data-state", "confirmed");
    await page.getByTestId("intent-BUY_YES").click();
    await expect(page.getByTestId("guard")).toHaveCount(0);
    await expect(page.getByTestId("summary-copy")).toContainText("NVDA closes at or above $190.00");
  });

  test("two tabs: a Buy Yes in one tab blocks a Buy No in the other (POS-07)", async ({ context }) => {
    const a = await context.newPage();
    const b = await context.newPage();
    await connect(a);
    await connect(b);
    const id = await marketId("GOOGL", 175);
    await b.goto(`/trade/?m=${id}&intent=BUY_NO`);
    await expect(b.getByTestId("summary-copy")).toContainText("closes below");
    await a.goto(`/trade/?m=${id}&intent=BUY_YES`);
    await a.getByTestId("submit").click();
    await expect(a.getByTestId("tx-status")).toHaveAttribute("data-state", "confirmed");
    // Tab B was quoted before; its next build (a re-quote or the submit) is refused by the builder.
    if (await b.getByTestId("submit").isEnabled()) await b.getByTestId("submit").click();
    await expect(b.getByTestId("guard")).toContainText("Sell your Yes first");
    await expect(b.getByTestId("guard-action")).toHaveText("Sell Yes first");
    await expect(b.getByTestId("tx-status")).toHaveCount(0);
    expect(await b.evaluate(() => (window as unknown as { __tw: { requests: string[] } }).__tw.requests.filter((r) => r === "signTransaction").length)).toBe(0);
  });

  test("trading is disabled after close_time and while paused (HLT-05, PSE-06)", async ({ page }) => {
    await stub("/__stub/reset", { live: false, closeInS: 4 });
    const id = await marketId("META", 680);
    await page.goto(`/trade/?m=${id}`);
    await expect(page.getByTestId("trade-disabled")).toContainText("Trading closed at 4:00 PM ET", { timeout: 10_000 });
    await expect(page.getByTestId("phase-banner")).toHaveAttribute("data-phase", "HALTED");

    await stub("/__stub/reset", { live: false });
    await page.reload();
    await expect(page.getByTestId("trade-disabled")).toHaveCount(0);
    await stub("/__stub/pause", { paused: true });
    await expect(page.getByTestId("trade-disabled")).toContainText("paused");
    await expect(page.getByTestId("phase-banner")).toHaveAttribute("data-phase", "PAUSED");
  });
});

test.describe("portfolio", () => {
  test("P&L, pending Buy No, settlement display (FE-07, POS-05)", async ({ page }) => {
    await connect(page);
    await signIn(page);
    const meta = await marketId("META", 680);
    const positions = await page.evaluate(async () => {
      const t = Object.keys(sessionStorage).find((k) => k.startsWith("meridian.jwt."))!;
      const tok = JSON.parse(sessionStorage.getItem(t)!).token;
      return fetch("http://localhost:8787/v1/me/positions?status=ALL", { headers: { authorization: `Bearer ${tok}` } }).then((r) => r.json());
    });
    const p = positions.data.find((x: { marketId: string }) => x.marketId === meta);
    const fmt = (m: string) => {
      const n = BigInt(m);
      const a = n < 0n ? -n : n;
      return `${n < 0n ? "-" : n > 0n ? "+" : ""}$${a / 1_000_000n}.${((a % 1_000_000n) / 10_000n).toString().padStart(2, "0")}`;
    };
    await expect(page.getByTestId(`pos-${meta}`).getByTestId("unrealized")).toHaveText(fmt(p.unrealizedPnl));
    await expect(page.getByTestId("open-positions")).toContainText("Buy No pending");
    await expect(page.getByTestId("settled-positions")).toContainText("$341.27");
  });

  test("settled winner redeems for $1.00 a token; loser shows $0.00 with Clear (FE-08)", async ({ page }) => {
    await connect(page);
    await signIn(page);
    const rows = page.getByTestId("settled-positions").locator("tbody tr");
    await expect(rows.filter({ hasText: "TSLA" }).getByTestId("per-token")).toHaveText("$1.00");
    await expect(rows.filter({ hasText: "MSFT" }).getByTestId("per-token")).toHaveText("$0.00");
    await expect(rows.filter({ hasText: "MSFT" }).getByTestId("clear")).toBeVisible();
    await page.getByTestId("redeem").click();
    await expect(page.getByTestId("tx-status")).toHaveAttribute("data-state", "confirmed");
    await expect(rows.filter({ hasText: "TSLA" })).toContainText("Redeemed");
    await expect(page.getByTestId("usdc-balance")).toHaveText("$1,050.00 USDC");
  });

  test("claim maker proceeds (FE-11)", async ({ page }) => {
    await connect(page);
    await signIn(page);
    await expect(page.getByTestId("claim")).toHaveText("Claim $12.40");
    await page.getByTestId("claim").click();
    await expect(page.getByTestId("tx-status")).toHaveAttribute("data-state", "confirmed");
    await expect(page.getByTestId("claim")).toHaveCount(0);
    await expect(page.getByTestId("usdc-balance")).toHaveText("$1,012.40 USDC");
  });
});

test.describe("history", () => {
  test("rows show the user's intent and price, with explorer links (FE-12)", async ({ page }) => {
    await connect(page);
    await page.goto("/history/");
    const rows = page.getByTestId("history-row");
    await expect(rows.first()).toBeVisible();
    await expect(page.getByTestId("history-table")).not.toContainText(/\b(BID|ASK)\b/);
    await expect(rows.filter({ hasText: "Sold No" })).toContainText("63¢ No");
    await expect(rows.filter({ hasText: "Bought Yes" }).first()).toContainText("58¢ Yes");
    await expect(rows.first().getByTestId("sig-link")).toHaveAttribute("href", /^https:\/\/explorer\.solana\.com\/tx\/\w+\?cluster=devnet$/);
  });
});

test.describe("mobile (375 px)", () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test("Trade and Portfolio have no horizontal scroll and actions stay reachable (FE-13)", async ({ page }) => {
    await connect(page);
    const id = await marketId("META", 680);
    await page.goto(`/trade/?m=${id}`);
    await expect(page.getByTestId("trade-panel")).toBeVisible();
    await noHorizontalScroll(page);
    await expect(page.getByTestId("submit")).toBeInViewport({ ratio: 0.1 }).catch(async () => {
      await page.getByTestId("submit").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("submit")).toBeInViewport();
    });
    await signIn(page);
    await noHorizontalScroll(page);
    await page.getByTestId("claim").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("claim")).toBeInViewport();
  });
});
