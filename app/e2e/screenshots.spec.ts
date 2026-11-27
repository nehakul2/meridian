/**
 * Screenshots for docs/phase7-screenshots (run with `npm run screenshots`; skipped otherwise).
 * Same stub and test wallet as the e2e suite.
 */
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { installTestWallet } from "./test-wallet";

const OUT = path.resolve(process.cwd(), "../docs/phase7-screenshots");
const STUB = "http://localhost:8787";

test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1");
test.use({ deviceScaleFactor: 2 });

const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: `${OUT}/${name}.jpg`, type: "jpeg", quality: 88, fullPage });
const marketId = async (symbol: string, strike: number) =>
  (await fetch(`${STUB}/v1/tickers/${symbol}/markets`).then((r) => r.json())).markets.find((m: { strikeCents: number }) => m.strikeCents === strike * 100).marketId as string;

async function connect(page: Page) {
  await installTestWallet(page);
  await page.goto("/");
  await page.getByTestId("connect-wallet").first().click();
  await page.getByRole("dialog").getByText("Meridian Test Wallet").click();
  await expect(page.getByTestId("wallet-pill")).toBeVisible();
}

test("desktop pages", async ({ page }) => {
  test.setTimeout(120_000);
  await fetch(`${STUB}/__stub/reset`, { method: "POST", body: JSON.stringify({ live: false }) });
  await installTestWallet(page);
  await page.goto("/");
  await expect(page.getByTestId("ticker-grid")).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, "01-landing");

  await page.getByTestId("connect-wallet").first().click();
  await page.waitForTimeout(200);
  await shot(page, "02-connect-wallet");
  await page.getByRole("dialog").getByText("Meridian Test Wallet").click();
  await expect(page.getByTestId("wallet-pill")).toBeVisible();

  await page.goto("/markets/?t=META");
  await expect(page.getByTestId("contract-68000").getByTestId("yes-ask")).not.toHaveText("—");
  await page.waitForTimeout(300);
  await shot(page, "03-markets", true);

  await page.goto("/portfolio/");
  await expect(page.getByTestId("open-positions")).toBeVisible();
  await expect(page.getByTestId("settled-positions")).toContainText("$341.27");
  await shot(page, "04-portfolio", true);

  const meta = await marketId("META", 680);
  await page.goto(`/trade/?m=${meta}&intent=BUY_YES`);
  await page.getByTestId("intent-SELL_YES").click();
  await page.getByTestId("qty").fill("50");
  await expect(page.getByTestId("summary-copy")).toBeVisible();
  await shot(page, "05-trade-yes-view");

  const nvda = await marketId("NVDA", 190);
  await page.goto(`/trade/?m=${nvda}&intent=BUY_YES`);
  await page.getByRole("button", { name: "No view" }).click();
  await expect(page.getByTestId("guard")).toBeVisible();
  await shot(page, "06-trade-no-view-position-guard");

  await page.getByTestId("guard-action").click();
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("tx-status")).toHaveAttribute("data-state", "confirmed");
  await shot(page, "07-trade-confirmed");

  await page.goto("/history/");
  await expect(page.getByTestId("history-row").first()).toContainText("Sold No");
  await page.waitForTimeout(300);
  await shot(page, "08-history");
});

test("closed and paused states", async ({ page }) => {
  await fetch(`${STUB}/__stub/reset`, { method: "POST", body: JSON.stringify({ live: false, phase: "HALTED" }) });
  await connect(page);
  const meta = await marketId("META", 680);
  await page.goto(`/trade/?m=${meta}`);
  await expect(page.getByTestId("trade-disabled")).toBeVisible();
  await shot(page, "09-trade-after-close");
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  test("trade and portfolio at 375 px", async ({ page }) => {
    await fetch(`${STUB}/__stub/reset`, { method: "POST", body: JSON.stringify({ live: false }) });
    await connect(page);
    const meta = await marketId("META", 680);
    await page.goto(`/trade/?m=${meta}`);
    await expect(page.getByTestId("summary-copy")).toBeVisible();
    await shot(page, "10-mobile-trade");
    await page.goto("/portfolio/");
    await expect(page.getByTestId("open-positions")).toBeVisible();
    await shot(page, "11-mobile-portfolio");
  });
});
