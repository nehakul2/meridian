import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // pg.test.ts and the LiteSVM suites start their own Postgres / load the program.
    pool: "forks",
  },
});
