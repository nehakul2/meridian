/**
 * Monitor entry point (C9, ops tier). Every CHECK_INTERVAL_S (default 15) it snapshots Postgres,
 * Redis, RPC and the WS gateways, evaluates the rules and stores / routes new alerts.
 *
 * Env: DATABASE_URL (read access + INSERT on alerts), REDIS_URL, RPC_URL, PROGRAM_ID (default: the
 * committed IDL address), WS_HEALTH_URLS (comma-separated id=url, e.g. ws-1=http://ws-1:8080/healthz),
 * ONCALL_WEBHOOK_URL (Slack-compatible incoming webhook for PAGE alerts).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Redis } from "ioredis";
import { AlertRouter, jsonLogger, PgAlertStore, WebhookOnCall } from "./alerts.js";
import { Collector, rpcNewestProgramTx } from "./collect.js";
import { evaluate } from "./rules.js";

function programId(): string {
  if (process.env.PROGRAM_ID) return process.env.PROGRAM_ID;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const p = join(dir, "programs/meridian/idl/meridian.json");
    if (existsSync(p)) return (JSON.parse(readFileSync(p, "utf8")) as { address: string }).address;
    dir = dirname(dir);
  }
  throw new Error("PROGRAM_ID is required");
}

export function parseGateways(v: string | undefined): { id: string; url: string }[] {
  return (v ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x, i) => {
    const [a, b] = x.includes("=") ? x.split("=", 2) as [string, string] : [`ws-${i + 1}`, x];
    return { id: a, url: b };
  });
}

async function main() {
  const db = process.env.DATABASE_URL;
  if (!db) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: db });
  const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;
  const rpc = process.env.RPC_URL;
  const collector = new Collector({
    pool, redis, gateways: parseGateways(process.env.WS_HEALTH_URLS),
    newestProgramTx: rpc ? rpcNewestProgramTx(rpc, programId()) : async () => null,
  });
  const oncall = process.env.ONCALL_WEBHOOK_URL ? new WebhookOnCall(process.env.ONCALL_WEBHOOK_URL) : null;
  if (!oncall) jsonLogger.warn("ONCALL_WEBHOOK_URL not set: PAGE alerts are stored and logged only");
  const router = new AlertRouter(new PgAlertStore(pool), oncall, jsonLogger);
  const interval = Number(process.env.CHECK_INTERVAL_S ?? 15) * 1000;
  let stop = false;
  process.on("SIGTERM", () => (stop = true));
  jsonLogger.info("monitor started", { intervalMs: interval });
  while (!stop) {
    try {
      await router.route(evaluate(await collector.snapshot(Math.floor(Date.now() / 1000))));
    } catch (e) {
      jsonLogger.error("monitor check failed", { error: String(e) });
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  await redis?.quit();
  await pool.end();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
