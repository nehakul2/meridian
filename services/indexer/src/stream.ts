/**
 * MER-50 / MER-52: appends entries to `md:events` (spec 6.3). The append is idempotent on
 * the natural key (sig, ix, ev, commitment): a dedupe marker is set in the same Lua script,
 * so a replay, a backfill or a second leader never adds a duplicate entry. When a leader
 * token is given, the script also refuses to write unless that token still holds
 * `md:lock:indexer` (fencing: an old leader that wakes up cannot write).
 */
import type { Redis } from "ioredis";
import { STREAM_KEY, STREAM_MAXLEN, StreamEntry, toFields } from "../../shared/src/events.js";
import { K, TTL } from "./keys.js";

const APPEND = `
if ARGV[1] ~= '' and redis.call('GET', KEYS[3]) ~= ARGV[1] then
  return redis.error_reply('NOTLEADER')
end
if redis.call('SET', KEYS[2], '1', 'NX', 'EX', ARGV[2]) then
  return redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[3], '*', unpack(ARGV, 4))
end
return false
`;

export class NotLeaderError extends Error {
  constructor() {
    super("not the indexer leader");
  }
}

export function entryKey(e: StreamEntry): string {
  return e.type === "control" ? `${e.sig}:${e.kind}` : `${e.sig}:${e.ix}:${e.ev}:${e.commitment}`;
}

export class EventStream {
  constructor(private readonly redis: Redis, private readonly token: () => string = () => "", private readonly maxLen = STREAM_MAXLEN) {}

  /** Appends one entry; returns its stream id, or null when it was already appended. */
  async append(e: StreamEntry): Promise<string | null> {
    try {
      const r = await this.redis.eval(APPEND, 3, STREAM_KEY, K.dedupe(entryKey(e)), K.lock,
        this.token(), String(TTL.dedupe), String(this.maxLen), ...toFields(e));
      return (r as string | null) ?? null;
    } catch (err) {
      if (String((err as Error).message).includes("NOTLEADER")) throw new NotLeaderError();
      throw err;
    }
  }
}
