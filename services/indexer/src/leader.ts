/**
 * MER-52: leader lease on `md:lock:indexer` (spec 3.4: 10 s TTL, renewed every 3 s). Only
 * the holder writes: the stream append checks the token in Lua, and every projector MULTI
 * runs under WATCH of the lock so it aborts if the lease moved.
 */
import { randomUUID } from "node:crypto";
import type { ChainableCommander, Redis } from "ioredis";
import { K } from "./keys.js";
import type { WriteGuard } from "./projector.js";
import { NotLeaderError } from "./stream.js";

const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

export interface LeaseOptions {
  ttlMs?: number;
  renewMs?: number;
}

export class LeaderLease implements WriteGuard {
  readonly id: string;
  readonly ttlMs: number;
  readonly renewMs: number;
  private held = false;

  constructor(private readonly redis: Redis, o: LeaseOptions & { id?: string } = {}) {
    this.id = o.id ?? randomUUID();
    this.ttlMs = o.ttlMs ?? 10_000;
    this.renewMs = o.renewMs ?? 3_000;
  }

  get isLeader() {
    return this.held;
  }

  /** The token the stream append checks; empty when not leader (so writes are refused). */
  token = () => (this.held ? this.id : "!" + this.id);

  async tryAcquire(): Promise<boolean> {
    const r = await this.redis.set(K.lock, this.id, "PX", this.ttlMs, "NX");
    this.held = r === "OK" || (await this.redis.get(K.lock)) === this.id;
    return this.held;
  }

  async renew(): Promise<boolean> {
    const r = (await this.redis.eval(RENEW, 1, K.lock, this.id, String(this.ttlMs))) as number;
    this.held = r === 1;
    return this.held;
  }

  async release(): Promise<void> {
    await this.redis.eval(RELEASE, 1, K.lock, this.id);
    this.held = false;
  }

  /**
   * MULTI under WATCH of the lock. A renewal (PEXPIRE) also touches the watched key, so an
   * aborted EXEC is retried while the lease is still ours.
   */
  async exec(redis: Redis, build: (m: ChainableCommander) => void): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      await redis.watch(K.lock);
      if ((await redis.get(K.lock)) !== this.id) {
        await redis.unwatch();
        this.held = false;
        throw new NotLeaderError();
      }
      const m = redis.multi();
      build(m);
      const r = await m.exec();
      if (!r) continue;
      for (const [err] of r) if (err) throw err;
      return;
    }
    this.held = false;
    throw new NotLeaderError();
  }
}
