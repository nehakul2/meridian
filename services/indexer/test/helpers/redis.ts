/**
 * A throwaway Redis for the tests: TEST_REDIS_URL if set (CI service container), else a
 * redis-server started on a random port. Returns null when neither is available (the
 * suites are skipped, or fail when REQUIRE_REDIS is set).
 */
import { spawn, spawnSync } from "node:child_process";
import { Redis } from "ioredis";

export interface TestRedis {
  url: string;
  client(): Redis;
  flush(): Promise<void>;
  stop(): Promise<void>;
}

export async function startTestRedis(): Promise<TestRedis | null> {
  const r = await inner();
  if (!r && process.env.REQUIRE_REDIS) throw new Error("REQUIRE_REDIS is set but no Redis is available (set TEST_REDIS_URL)");
  return r;
}

async function inner(): Promise<TestRedis | null> {
  const clients: Redis[] = [];
  const make = (url: string, stopServer: () => void): TestRedis => ({
    url,
    client() {
      const c = new Redis(url, { maxRetriesPerRequest: 2 });
      c.on("error", () => undefined); // the server goes away at the end of the suite
      clients.push(c);
      return c;
    },
    async flush() {
      const c = new Redis(url);
      await c.flushall();
      await c.quit();
    },
    async stop() {
      await Promise.all(clients.splice(0).map((c) => c.quit().catch(() => c.disconnect())));
      stopServer();
    },
  });
  if (process.env.TEST_REDIS_URL) return make(process.env.TEST_REDIS_URL, () => undefined);
  if (spawnSync("redis-server", ["--version"]).status !== 0) return null;
  const port = 21000 + Math.floor(Math.random() * 20000);
  const proc = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no", "--bind", "127.0.0.1"], { stdio: "ignore" });
  const url = `redis://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    const c = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    try {
      await c.connect();
      await c.ping();
      await c.quit();
      return make(url, () => proc.kill("SIGKILL"));
    } catch {
      c.disconnect();
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  proc.kill("SIGKILL");
  return null;
}

/** Every Indexer-owned key and its value, sorted, for golden comparisons. */
export async function dumpRedis(r: Redis, skip: RegExp = /^md:(evk:|events$|backfill$)/): Promise<Record<string, unknown>> {
  const keys = (await r.keys("md:*")).filter((k) => !skip.test(k)).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const t = await r.type(k);
    if (t === "string") out[k] = await r.get(k);
    else if (t === "hash") out[k] = Object.fromEntries(Object.entries(await r.hgetall(k)).sort());
    else if (t === "set") out[k] = (await r.smembers(k)).sort();
    else if (t === "zset") out[k] = await r.zrange(k, 0, -1, "WITHSCORES");
    else if (t === "list") out[k] = await r.lrange(k, 0, -1);
  }
  return out;
}
