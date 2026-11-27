import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    // A shared Redis (CI service container) has one pub/sub namespace: run files one at a time.
    fileParallelism: !process.env.TEST_REDIS_URL,
  },
});
