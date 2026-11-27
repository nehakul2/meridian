/** The Indexer's program-log cursor (`indexer_cursor`, stream 'program_logs'; MER-50). */
import type { Pool } from "pg";

export interface Cursor {
  lastSlot: number;
  lastSignature: string | null;
}

export interface CursorStore {
  get(stream: string): Promise<Cursor | null>;
  set(stream: string, c: Cursor): Promise<void>;
}

export class MemoryCursorStore implements CursorStore {
  readonly rows = new Map<string, Cursor>();
  async get(stream: string) {
    return this.rows.get(stream) ?? null;
  }
  async set(stream: string, c: Cursor) {
    this.rows.set(stream, { ...c });
  }
}

export class PgCursorStore implements CursorStore {
  constructor(private readonly pool: Pool) {}
  async get(stream: string): Promise<Cursor | null> {
    const r = await this.pool.query("SELECT last_slot, last_signature FROM indexer_cursor WHERE stream = $1", [stream]);
    if (r.rowCount === 0) return null;
    return { lastSlot: Number(r.rows[0].last_slot), lastSignature: r.rows[0].last_signature };
  }
  async set(stream: string, c: Cursor): Promise<void> {
    await this.pool.query(
      `INSERT INTO indexer_cursor (stream, last_slot, last_signature, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (stream) DO UPDATE SET last_slot = EXCLUDED.last_slot, last_signature = EXCLUDED.last_signature, updated_at = now()
       WHERE indexer_cursor.last_slot <= EXCLUDED.last_slot`,
      [stream, c.lastSlot, c.lastSignature],
    );
  }
}
