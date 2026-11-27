/**
 * A throwaway Postgres for pg.test.ts: TEST_DATABASE_URL if set (CI service container),
 * else a local cluster started with the installed binaries in a temp dir. Returns null
 * when neither is available, and the suite is skipped.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestDb {
  url: string;
  stop(): void;
}

function pgBin(): string | null {
  const base = "/usr/lib/postgresql";
  if (!existsSync(base)) return null;
  const v = readdirSync(base).sort().pop();
  const dir = v ? join(base, v, "bin") : null;
  return dir && existsSync(join(dir, "pg_ctl")) ? dir : null;
}

export function startTestDb(): TestDb | null {
  const db = startTestDbInner();
  if (!db && process.env.REQUIRE_PG) throw new Error("REQUIRE_PG is set but no Postgres is available (set TEST_DATABASE_URL)");
  return db;
}

function startTestDbInner(): TestDb | null {
  if (process.env.TEST_DATABASE_URL) return { url: process.env.TEST_DATABASE_URL, stop() {} };
  const bin = pgBin();
  if (!bin) return null;
  const asRoot = process.getuid?.() === 0;
  const run = (cmd: string, args: string[]) =>
    asRoot ? execFileSync("runuser", ["-u", "postgres", "--", join(bin, cmd), ...args], { stdio: "pipe" })
      : execFileSync(join(bin, cmd), args, { stdio: "pipe" });
  try {
    const dir = mkdtempSync(join(tmpdir(), "meridian-pg-"));
    chmodSync(dir, 0o777);
    const data = join(dir, "data");
    const port = 20000 + Math.floor(Math.random() * 20000);
    run("initdb", ["-D", data, "-A", "trust", "-U", "postgres", "--no-sync"]);
    run("pg_ctl", ["-D", data, "-l", join(dir, "log"), "-w", "-o", `-p ${port} -k ${dir} -c fsync=off -c listen_addresses=localhost`, "start"]);
    return {
      url: `postgres://postgres@localhost:${port}/postgres`,
      stop() {
        try {
          run("pg_ctl", ["-D", data, "-m", "immediate", "stop"]);
        } catch {
          /* already stopped */
        }
      },
    };
  } catch (e) {
    const which = spawnSync("id", ["postgres"]);
    if (which.status !== 0) return null;
    console.warn("could not start a local Postgres for pg.test.ts:", (e as Error).message);
    return null;
  }
}
