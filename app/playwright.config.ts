import { defineConfig, devices } from "@playwright/test";

/**
 * MER-76. Runs the static build (`npm run build` first) against the local stub backend, which
 * speaks the Phase 6 REST, Tx Builder, WebSocket and RPC contracts. One worker: the stub holds
 * one shared state that each test resets.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1360, height: 900 },
  },
  webServer: [
    { command: "npx tsx dev/stub-server.ts", url: "http://localhost:8787/v1/health", reuseExistingServer: !process.env.CI, timeout: 30_000 },
    { command: "npx http-server out -p 3000 -c-1 --silent", url: "http://localhost:3000", reuseExistingServer: !process.env.CI, timeout: 30_000 },
  ],
});
