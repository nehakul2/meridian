/**
 * Indexer entry point (C6). Env: RPC_URL, RPC_WS_URL (optional), REDIS_URL, DATABASE_URL,
 * INDEXER_ID (optional). Runs as active or hot standby on `md:lock:indexer`.
 */
import { Connection } from "@solana/web3.js";
import { Redis } from "ioredis";
import pg from "pg";
import { PgCursorStore } from "./cursor.js";
import { Indexer } from "./indexer.js";
import { LeaderLease } from "./leader.js";
import { IndexerNode } from "./node.js";
import { Projector } from "./projector.js";
import { RpcSource } from "./source.js";
import { EventStream } from "./stream.js";

function env(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
}

async function main() {
  const redis = new Redis(env("REDIS_URL"));
  const leaseRedis = new Redis(env("REDIS_URL"));
  const pool = new pg.Pool({ connectionString: env("DATABASE_URL") });
  const conn = new Connection(env("RPC_URL"), { commitment: "confirmed", wsEndpoint: process.env.RPC_WS_URL });
  const source = new RpcSource(conn);
  const lease = new LeaderLease(leaseRedis, { id: process.env.INDEXER_ID });
  const projector = new Projector(redis, { guard: lease });
  const stream = new EventStream(redis, lease.token);
  const indexer = new Indexer({ redis, source, cursor: new PgCursorStore(pool), projector, stream, isLeader: () => lease.isLeader });
  const node = new IndexerNode(lease.id, lease, indexer, source, projector);
  await node.start();
  const stop = async () => {
    await node.stop();
    await Promise.all([redis.quit(), leaseRedis.quit(), pool.end()]);
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

void main();
