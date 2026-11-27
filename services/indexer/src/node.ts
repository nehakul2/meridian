/**
 * MER-52: one Indexer process, active or hot standby. The standby polls the lease; when it
 * gets it, it backfills from the last processed slot and only then goes live (logs
 * subscription, backfill requests, finality checks). Losing the lease stops live work at
 * once, and fencing refuses any write still in flight.
 */
import { Indexer } from "./indexer.js";
import type { LeaderLease } from "./leader.js";
import type { ChainSource } from "./source.js";
import type { Projector } from "./projector.js";
import { NotLeaderError } from "./stream.js";

export interface NodeOptions {
  finalityEveryMs?: number;
  backfillPollMs?: number;
}

export class IndexerNode {
  private timers: NodeJS.Timeout[] = [];
  private unsub: (() => void)[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  live = false;
  readonly events: string[] = [];

  constructor(
    readonly name: string,
    private readonly lease: LeaderLease,
    readonly indexer: Indexer,
    private readonly source: ChainSource,
    private readonly projector: Projector,
    private readonly o: NodeOptions = {},
  ) {}

  /** Serializes work so events are processed in arrival order. */
  private enqueue<T>(f: () => Promise<T>): Promise<T> {
    const p = this.queue.then(f, f);
    this.queue = p.catch((e) => {
      if (e instanceof NotLeaderError) this.demote();
      else this.indexer.log.warn("indexer task failed", { node: this.name, err: String((e as Error).message) });
    });
    return p;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.tick();
    this.timers.push(setInterval(() => void this.tick(), this.lease.renewMs));
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      if (this.lease.isLeader) {
        if (!(await this.lease.renew())) this.demote();
      } else if (await this.lease.tryAcquire()) {
        this.events.push("leader");
        await this.enqueue(() => this.indexer.backfill());
        if (this.lease.isLeader) this.goLive();
      }
    } catch (e) {
      this.indexer.log.warn("lease tick failed", { node: this.name, err: String((e as Error).message) });
    }
  }

  private goLive() {
    this.live = true;
    this.events.push("live");
    this.unsub.push(this.source.onLogs((sig, _slot, err) => {
      if (!err) void this.enqueue(() => this.indexer.processSignature(sig));
    }));
    if (this.source.onTickerDay) this.unsub.push(this.source.onTickerDay((td) => void this.enqueue(() => this.projector.applyTickerDay(td))));
    this.timers.push(setInterval(() => void this.enqueue(() => this.indexer.checkFinality()), this.o.finalityEveryMs ?? 5_000));
    this.timers.push(setInterval(() => void this.enqueue(() => this.indexer.serveBackfillRequests()), this.o.backfillPollMs ?? 1_000));
  }

  private demote() {
    if (!this.live && !this.lease.isLeader) return;
    this.events.push("standby");
    this.live = false;
    for (const u of this.unsub.splice(0)) u();
    // Keep only the lease timer (the first one).
    for (const t of this.timers.splice(1)) clearInterval(t);
  }

  /** Simulates a crash: stops everything without releasing the lease. */
  freeze() {
    this.stopped = true;
    this.live = false;
    for (const u of this.unsub.splice(0)) u();
    for (const t of this.timers.splice(0)) clearInterval(t);
  }

  /** Comes back after a freeze, still believing it is the leader (MER-52 fencing test). */
  wake() {
    this.stopped = false;
  }

  async stop(): Promise<void> {
    this.freeze();
    await this.queue.catch(() => undefined);
    if (this.lease.isLeader) await this.lease.release();
  }
}
