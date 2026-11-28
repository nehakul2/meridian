// The harness runs the real services (api, txb, ws, indexer, pg-writer) and the devnet scripts'
// LiteSVM stand-in in one process. They must share one copy of each library, so every import
// resolves to tests/load/node_modules (same approach as scripts/vitest.config.ts).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const nm = join(dirname(fileURLToPath(import.meta.url)), "node_modules");
const shared = ["@solana/web3.js", "bn.js", "@coral-xyz/anchor", "litesvm", "@pythnetwork/pyth-solana-receiver", "fastify", "ioredis", "pg", "ws"];
export default defineConfig({
  resolve: { alias: Object.fromEntries(shared.map((p) => [p, join(nm, p)])) },
  test: {
    include: [process.env.LOAD_INCLUDE ?? "load.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 300_000,
    pool: "forks",
    fileParallelism: false,
  },
});
