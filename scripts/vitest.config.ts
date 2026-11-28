// The devnet scripts import the automation and Tx Builder chain modules from services/. They and
// this package must share one copy of web3.js, BN, Anchor and LiteSVM, so all of them resolve to
// scripts/node_modules (the same trick as services/indexer/scripts/vitest.record.ts).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const nm = join(dirname(fileURLToPath(import.meta.url)), "node_modules");
export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      ["@solana/web3.js", "bn.js", "@coral-xyz/anchor", "litesvm", "@pythnetwork/pyth-solana-receiver"].map((p) => [p, join(nm, p)]),
    ),
  },
  test: {
    include: ["__tests__/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
