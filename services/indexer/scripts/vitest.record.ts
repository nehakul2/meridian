// Runs scripts/record-fixture.rec.ts. The automation modules it imports and this script must
// share one copy of web3.js, BN, Anchor and LiteSVM, so all of them resolve to
// services/automation/node_modules.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const auto = join(dirname(fileURLToPath(import.meta.url)), "../../automation/node_modules");
export default defineConfig({
  resolve: {
    alias: Object.fromEntries(["@solana/web3.js", "bn.js", "@coral-xyz/anchor", "litesvm"].map((p) => [p, join(auto, p)])),
  },
  test: { include: ["scripts/*.rec.ts"], testTimeout: 120_000, pool: "forks" },
});
