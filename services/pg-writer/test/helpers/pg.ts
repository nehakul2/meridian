/**
 * A fresh Postgres database with the spec 5 migrations for each test file. Uses
 * TEST_DATABASE_URL as the server if set (CI service container), else a local cluster
 * started with the installed binaries. Returns null when neither is available.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../../../db/migrations");

export interface TestDb {
  pool: pg.Pool;
  stop(): Promise<void>;
}

function pgBin(): string | null {
  const base = "/usr/lib/postgresql";
  if (!existsSync(base)) return null;
  const v = readdirSync(base).sort().pop();
  const dir = v ? join(base, v, "bin") : null;
  return dir && existsSync(join(dir, "pg_ctl")) ? dir : null;
}

function localServer(): { url: string; stop(): void } | null {
  const bin = pgBin();
  if (!bin) return null;
  const asRoot = process.getuid?.() === 0;
  const run = (cmd: string, args: string[]) =>
    asRoot ? execFileSync("runuser", ["-u", "postgres", "--", join(bin, cmd), ...args], { stdio: "pipe" })
      : execFileSync(join(bin, cmd), args, { stdio: "pipe" });
  try {
    const dir = mkdtempSync(join(tmpdir(), "meridian-pgw-"));
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
  } catch {
    return null;
  }
}

export async function startTestDb(): Promise<TestDb | null> {
  const server = process.env.TEST_DATABASE_URL ? { url: process.env.TEST_DATABASE_URL, stop() {} } : localServer();
  if (!server) {
    if (process.env.REQUIRE_PG) throw new Error("REQUIRE_PG is set but no Postgres is available (set TEST_DATABASE_URL)");
    return null;
  }
  const name = `pgw_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
  const admin = new pg.Client({ connectionString: server.url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(server.url);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
  for (const f of readdirSync(MIGRATIONS).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) {
    await pool.query(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  await pool.query("INSERT INTO tickers (symbol, pyth_feed_id) VALUES ('META', decode(repeat('06',32),'hex'))");
  return {
    pool,
    async stop() {
      await pool.end();
      const a = new pg.Client({ connectionString: server.url });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name}`);
      await a.end();
      server.stop();
    },
  };
}

/** Every chain-derived table, rows sorted, for exact comparisons. */
export async function dumpTables(pool: pg.Pool): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of ["chain_events", "ticker_days", "markets", "disputes", "orders", "fills", "mint_merge_redeem", "positions", "candles_1m"]) {
    const r = await pool.query(`SELECT * FROM ${t}`);
    out[t] = r.rows.map((row) => JSON.parse(JSON.stringify(row))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return out;
}
