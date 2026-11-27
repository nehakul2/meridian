/**
 * PG Writer entry point (C7). Env: REDIS_URL, DATABASE_URL, MARKET_CREATOR (optional,
 * pubkey stored as created_by = 'AUTO'), CONSUMER (optional consumer name).
 */
import { Redis } from "ioredis";
import pg from "pg";
import { RedisBackfiller, StreamConsumer } from "./consumer.js";
import { PgWriter } from "./writer.js";

function env(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
}

async function main() {
  const redis = new Redis(env("REDIS_URL"));
  const pool = new pg.Pool({ connectionString: env("DATABASE_URL") });
  const writer = new PgWriter(pool, new RedisBackfiller(redis), { marketCreator: process.env.MARKET_CREATOR });
  const consumer = new StreamConsumer(redis, writer, pool, process.env.CONSUMER ?? "pgw-1");
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  while (running) {
    try {
      await consumer.poll(1000);
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "poll failed", err: String((e as Error).message) }));
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await redis.quit();
  await pool.end();
}

void main();
