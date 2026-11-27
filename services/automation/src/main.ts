/**
 * Automation service entry point (C8). Runs as its own deployment with its own RPC
 * endpoint and key store (spec 3.4 ops tier). Loads only the `market_creator` and
 * `settler` hot keys plus the fee payer; never an admin or upgrade key (D23, SEC-06).
 *
 *   node dist/src/main.js                 run the scheduler loop
 *   node dist/src/main.js calendar-load Y load trading_calendar for year Y
 *   node dist/src/main.js run JOB DATE    manual rerun of an idempotent job
 */
import {
  AddressLookupTableProgram, Connection, Keypair, PublicKey,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Redis } from "ioredis";
import { Alerter, jsonLogger } from "./alerts.js";
import { buildCalendarYear, CalendarOverrides, TradingCalendar } from "./calendar.js";
import { MeridianChain, RpcReader, RpcSender } from "./chain/client.js";
import { PythReceiverPoster } from "./chain/pyth.js";
import { runCloseBook, runFinalize, runPrune, runStrikeCrank } from "./jobs/cranks.js";
import type { AltManager, Deps, KeyValue } from "./jobs/common.js";
import { runMorning } from "./jobs/morning.js";
import { RpcChainHistory, runReconcile } from "./jobs/reconcile.js";
import { runSettle } from "./jobs/settler.js";
import { HermesClient } from "./oracle/hermes.js";
import { Scheduler } from "./scheduler.js";
import { migrate, PgStore } from "./store/pg.js";
import type { JobName } from "./store/types.js";
import { systemClock } from "./time.js";
import { DatabentoClient } from "./vendors/databento.js";
import { MassiveClient } from "./vendors/massive.js";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`${name} is required`);
  return v;
}

function keypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

class RedisKv implements KeyValue {
  constructor(private readonly r: Redis) {}
  get(k: string) {
    return this.r.get(k);
  }
  async set(k: string, v: string, ttlS: number) {
    await this.r.set(k, v, "EX", ttlS);
  }
}

/** Creates and fills an ALT, paid by the automation wallet. */
class RpcAltManager implements AltManager {
  constructor(private readonly conn: Connection, private readonly chain: MeridianChain) {}
  async create(addresses: PublicKey[]) {
    const payer = this.chain.keys.payer;
    const slot = await this.conn.getSlot("finalized");
    const [ix, table] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot });
    const sigs = [await this.chain.sender.send([ix], [payer])];
    for (let i = 0; i < addresses.length; i += 25) {
      const ext = AddressLookupTableProgram.extendLookupTable({
        lookupTable: table, authority: payer.publicKey, payer: payer.publicKey, addresses: addresses.slice(i, i + 25),
      });
      sigs.push(await this.chain.sender.send([ext], [payer]));
    }
    return { table, sigs };
  }
}

async function main() {
  const log = jsonLogger;
  const pool = new pg.Pool({ connectionString: env("DATABASE_URL") });
  const here = dirname(fileURLToPath(import.meta.url));
  const migrations = process.env.MIGRATIONS_DIR ?? join(here, "../../../../db/migrations");
  const [cmd, a1, a2] = process.argv.slice(2);
  const store = new PgStore(pool);

  if (cmd === "migrate") {
    log.info("migrations applied", { applied: await migrate(pool, migrations) });
    return pool.end();
  }
  if (cmd === "calendar-load") {
    const year = Number(a1 ?? new Date().getUTCFullYear());
    const overrides: CalendarOverrides = process.env.CALENDAR_OVERRIDES ? JSON.parse(readFileSync(process.env.CALENDAR_OVERRIDES, "utf8")) : {};
    const n = await store.upsertCalendar(buildCalendarYear(year, overrides));
    log.info("calendar loaded", { year, tradingDays: n });
    return pool.end();
  }

  const conn = new Connection(env("AUTOMATION_RPC_URL"), "confirmed");
  const payer = keypair(env("AUTOMATION_PAYER_KEYPAIR"));
  const chain = new MeridianChain(new RpcReader(conn), new RpcSender(conn, { maxPriorityMicroLamports: Number(process.env.MAX_PRIORITY_MICROLAMPORTS ?? 1_000_000) }), {
    payer,
    creator: process.env.MARKET_CREATOR_KEYPAIR ? keypair(process.env.MARKET_CREATOR_KEYPAIR) : undefined,
    settler: process.env.SETTLER_KEYPAIR ? keypair(process.env.SETTLER_KEYPAIR) : undefined,
  }, { priorityMicroLamports: Number(process.env.PRIORITY_MICROLAMPORTS ?? 0) });

  const massive = new MassiveClient({ apiKey: env("MASSIVE_API_KEY"), baseUrl: process.env.MASSIVE_BASE_URL });
  const databento = new DatabentoClient({ apiKey: env("DATABENTO_API_KEY"), dataset: process.env.DATABENTO_DATASET });
  const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;
  const calendar = new TradingCalendar(await store.calendarRows());
  const deps: Deps = {
    store, chain, calendar, clock: systemClock, log, alerter: new Alerter(store, log),
    hermes: new HermesClient({ baseUrl: env("HERMES_URL", "https://hermes.pyth.network") }),
    closes: { massive, databento }, iv: massive, corp: massive,
    poster: new PythReceiverPoster(conn), alt: new RpcAltManager(conn, chain), kv: redis ? new RedisKv(redis) : null,
  };
  const history = new RpcChainHistory(conn);
  const runner = async (job: JobName, date: string): Promise<unknown> => {
    switch (job) {
      case "MORNING": return runMorning(deps, date);
      case "SETTLE": return runSettle(deps, date, { priorityMicroLamports: Number(process.env.PRIORITY_MICROLAMPORTS ?? 0) });
      case "FINALIZE": return runFinalize(deps, date);
      case "STRIKE_CRANK": return runStrikeCrank(deps, date);
      case "PRUNE": return runPrune(deps, date);
      case "CLOSE_BOOK": return runCloseBook(deps, date);
      case "RECONCILE": return runReconcile(deps, history, date);
    }
  };
  const scheduler = new Scheduler(store, calendar, systemClock, runner, log);
  if (cmd === "run") {
    const out = await scheduler.rerun(env("JOB", a1), env("DATE", a2));
    log.info("manual run", { out });
    await redis?.quit();
    return pool.end();
  }
  log.info("automation scheduler started", { tradingDays: calendar.dates().length });
  process.on("SIGTERM", () => scheduler.stop());
  await scheduler.loop();
  await redis?.quit();
  await pool.end();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
