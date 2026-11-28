/**
 * Writing and routing alerts (MER-81). Monitor is the only writer of `alerts` besides Automation
 * (spec 3.1). An alert is stored once per open (code, symbol, date): while an unacked row exists
 * the candidate is dropped, so a rule that keeps firing every check does not flood the table or
 * the pager. PAGE alerts go to the on-call channel when they are first stored.
 */
import type pg from "pg";
import type { AlertCandidate } from "./rules.js";

export interface AlertRecord extends AlertCandidate {
  id: number;
  createdAt: number;
  ackedAt: number | null;
}

export interface AlertStore {
  /** Stores the alert unless an unacked one with the same (code, symbol, date) exists. Returns the new row, or null. */
  insertIfNew(a: AlertCandidate): Promise<AlertRecord | null>;
}

export interface OnCall {
  page(a: AlertRecord): Promise<void>;
}

export class MemoryAlertStore implements AlertStore {
  readonly rows: AlertRecord[] = [];
  constructor(private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}
  async insertIfNew(a: AlertCandidate) {
    if (this.rows.some((r) => r.ackedAt === null && r.code === a.code && r.symbol === a.symbol && r.date === a.date)) return null;
    const row = { ...a, id: this.rows.length + 1, createdAt: this.now(), ackedAt: null };
    this.rows.push(row);
    return row;
  }
  ack(id: number) {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.ackedAt = this.now();
  }
}

export class PgAlertStore implements AlertStore {
  constructor(private readonly pool: pg.Pool) {}
  async insertIfNew(a: AlertCandidate) {
    // A transaction-scoped advisory lock per key, so two Monitor replicas (or Monitor and
    // Automation raising the same code) cannot both insert the same open alert.
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`alert|${a.code}|${a.symbol ?? ""}|${a.date ?? ""}`]);
      const open = await c.query(
        `SELECT 1 FROM alerts WHERE acked_at IS NULL AND code=$1 AND symbol IS NOT DISTINCT FROM $2
           AND trading_date IS NOT DISTINCT FROM $3::date LIMIT 1`,
        [a.code, a.symbol, a.date],
      );
      if (open.rowCount) {
        await c.query("COMMIT");
        return null;
      }
      const r = await c.query(
        "INSERT INTO alerts (severity, code, symbol, trading_date, message) VALUES ($1,$2,$3,$4::date,$5) RETURNING id, extract(epoch from created_at)::bigint AS created",
        [a.severity, a.code, a.symbol, a.date, a.message],
      );
      await c.query("COMMIT");
      return { ...a, id: Number(r.rows[0].id), createdAt: Number(r.rows[0].created), ackedAt: null };
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
}

/** Slack-compatible incoming webhook (`{"text": ...}`), e.g. the on-call channel. */
export class WebhookOnCall implements OnCall {
  constructor(private readonly url: string, private readonly fetchFn: typeof fetch = fetch) {}
  async page(a: AlertRecord) {
    const text = `:rotating_light: PAGE ${a.code}${a.symbol ? ` ${a.symbol}` : ""}${a.date ? ` ${a.date}` : ""}: ${a.message}`;
    const r = await this.fetchFn(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!r.ok) throw new Error(`on-call webhook HTTP ${r.status}`);
  }
}

export interface Logger {
  info(msg: string, f?: Record<string, unknown>): void;
  warn(msg: string, f?: Record<string, unknown>): void;
  error(msg: string, f?: Record<string, unknown>): void;
}

export const jsonLogger: Logger = {
  info: (msg, f) => console.log(JSON.stringify({ level: "info", msg, ...f })),
  warn: (msg, f) => console.warn(JSON.stringify({ level: "warn", msg, ...f })),
  error: (msg, f) => console.error(JSON.stringify({ level: "error", msg, ...f })),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** Stores each candidate once and pages PAGE alerts. A failed page is logged and retried next check. */
export class AlertRouter {
  private readonly unpaged = new Map<number, AlertRecord>();
  constructor(private readonly store: AlertStore, private readonly oncall: OnCall | null, private readonly log: Logger) {}

  async route(candidates: AlertCandidate[]): Promise<AlertRecord[]> {
    const created: AlertRecord[] = [];
    for (const a of candidates) {
      const row = await this.store.insertIfNew(a);
      if (!row) continue;
      created.push(row);
      const f = row.severity === "PAGE" ? this.log.error : row.severity === "WARN" ? this.log.warn : this.log.info;
      f(`alert ${row.code}`, { severity: row.severity, symbol: row.symbol, date: row.date, message: row.message });
      if (row.severity === "PAGE") this.unpaged.set(row.id, row);
    }
    for (const [id, row] of this.unpaged) {
      if (!this.oncall) {
        this.unpaged.delete(id);
        continue;
      }
      try {
        await this.oncall.page(row);
        this.unpaged.delete(id);
      } catch (e) {
        this.log.warn("on-call page failed; will retry", { id, error: String(e) });
      }
    }
    return created;
  }
}
