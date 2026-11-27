/**
 * MER-53: consumer group `pgw` on `md:events` (spec 6.3). Reassembles whole instructions
 * (entries carry `ev` and `n`), hands them to the PgWriter, and acknowledges each entry
 * once its rows are committed. On start it first re-reads its own pending entries, so a
 * crash between commit and ack only replays (a no-op). The last acknowledged stream id is
 * kept in `indexer_cursor` ('redis_stream').
 */
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { BACKFILL_KEY, ChainEvent, fromFields, STREAM_KEY } from "../../shared/src/events.js";
import type { Backfiller, PgWriter } from "./writer.js";

export const GROUP = "pgw";

/** Sends gap backfill requests to the Indexer on `md:backfill`. */
export class RedisBackfiller implements Backfiller {
  constructor(private readonly redis: Redis) {}
  async request(market: string, fromSeq: bigint, toSeq: bigint): Promise<void> {
    await this.redis.xadd(BACKFILL_KEY, "MAXLEN", "~", "10000", "*", "market", market, "from_seq", fromSeq.toString(), "to_seq", toSeq.toString());
  }
}

type XEntries = [string, string[]][];

export class StreamConsumer {
  private partial: { ids: string[]; events: ChainEvent[] } | null = null;
  private started = false;
  /** Stream id → time it was committed (ms), for lag measurements. */
  readonly committedAt = new Map<string, number>();
  trackLag = false;

  constructor(
    private readonly redis: Redis,
    private readonly writer: PgWriter,
    private readonly pool: Pool | null,
    private readonly consumer = "pgw-1",
  ) {}

  private async ensureGroup() {
    if (this.started) return;
    try {
      await this.redis.xgroup("CREATE", STREAM_KEY, GROUP, "0", "MKSTREAM");
    } catch (e) {
      if (!String((e as Error).message).includes("BUSYGROUP")) throw e;
    }
    // Our own unacknowledged entries first (crash recovery).
    for (;;) {
      const own = await this.read("0", 500, 0);
      if (own.length === 0) break;
      await this.process(own);
      if (own.length < 500) break;
    }
    this.started = true;
  }

  private async read(id: string, count: number, blockMs: number): Promise<XEntries> {
    const args: (string | number)[] = ["GROUP", GROUP, this.consumer, "COUNT", count];
    if (blockMs > 0) args.push("BLOCK", blockMs);
    const r = (await (this.redis as unknown as { xreadgroup(...a: (string | number)[]): Promise<unknown> })
      .xreadgroup(...args, "STREAMS", STREAM_KEY, id)) as [string, XEntries][] | null;
    return r?.[0]?.[1] ?? [];
  }

  private ack = async (ids: string[]) => {
    if (ids.length === 0) return;
    await this.redis.xack(STREAM_KEY, GROUP, ...ids);
    if (this.trackLag) for (const id of ids) this.committedAt.set(id, Date.now());
    if (this.pool) {
      const last = ids.at(-1)!;
      await this.pool.query(
        `INSERT INTO indexer_cursor (stream, last_slot, last_stream_id, updated_at) VALUES ('redis_stream', 0, $1, now())
         ON CONFLICT (stream) DO UPDATE SET last_stream_id = EXCLUDED.last_stream_id, updated_at = now()`,
        [last],
      );
    }
  };

  private async process(entries: XEntries): Promise<number> {
    let handled = 0;
    for (const [id, fields] of entries) {
      const e = fromFields(fields);
      if (e.type === "control") {
        await this.writer.handle(e, () => void this.ack([id]));
        handled++;
        continue;
      }
      const { type: _t, ...ev } = e;
      if (!this.partial || this.partial.events[0]!.sig !== ev.sig || this.partial.events[0]!.ix !== ev.ix) {
        this.partial = { ids: [], events: [] };
      }
      this.partial.ids.push(id);
      this.partial.events.push(ev);
      if (ev.ev === ev.n - 1 || ev.n <= 1) {
        const { ids, events } = this.partial;
        this.partial = null;
        let acked: Promise<void> | null = null;
        await this.writer.handle(events, () => {
          acked = this.ack(ids);
        });
        if (acked) await acked;
        handled++;
      }
    }
    return handled;
  }

  /** Reads and handles one batch; returns the number of instructions/control entries handled. */
  async poll(blockMs = 0, count = 500): Promise<number> {
    await this.ensureGroup();
    const entries = await this.read(">", count, blockMs);
    return this.process(entries);
  }

  /** Polls until the stream has nothing new. */
  async drain(): Promise<number> {
    let n = 0;
    for (;;) {
      const k = await this.poll(0);
      n += k;
      if (k === 0) return n;
    }
  }
}
