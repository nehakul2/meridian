/** PostgreSQL Store over the spec 5 schema (db/migrations). */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import type { CalendarRow, CorporateActionRow } from "../calendar.js";
import type { StrikePolicy, Tier } from "../strikes.js";
import type { IsoDate } from "../time.js";
import type {
  AlertRow, FillRow, JobName, JobRunRow, JobStatus, OfficialCloseRow, OracleUpdateRow, Purpose,
  ReconcileReport, Store, StrikeInputsRow, TickerRow,
} from "./types.js";

// DATE stays a 'YYYY-MM-DD' string; BIGINT is read as string and converted to bigint here.
pg.types.setTypeParser(1082, (v: string) => v);

const ts = (unix: number) => new Date(unix * 1000);
const unix = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : null);
const big = (v: string | number | null) => (v === null ? null : BigInt(v));

/** Applies every `NNNN_*.sql` in order, once, tracked in `schema_migrations`. */
export async function migrate(pool: pg.Pool, dir: string): Promise<string[]> {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const applied = new Set((await pool.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const done: string[] = [];
  for (const f of readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()) {
    if (applied.has(f)) continue;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(readFileSync(join(dir, f), "utf8"));
      await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      await c.query("COMMIT");
      done.push(f);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  return done;
}

export class PgStore implements Store {
  constructor(private readonly pool: pg.Pool) {}

  async enabledTickers(): Promise<TickerRow[]> {
    const r = await this.pool.query("SELECT symbol, encode(pyth_feed_id,'hex') AS feed, liquidity_tier_override, enabled FROM tickers WHERE enabled ORDER BY symbol");
    return r.rows.map((x) => ({ symbol: x.symbol, pythFeedId: x.feed, liquidityTierOverride: x.liquidity_tier_override as Tier | null, enabled: x.enabled }));
  }

  private toPolicy(x: Record<string, any>): StrikePolicy {
    const tiers = (o: Record<string, number>) => ({ A: BigInt(o.A!), B: BigInt(o.B!), C: BigInt(o.C!) });
    return {
      id: x.id,
      stepLadderCents: (x.step_ladder_cents as number[]).map((v) => BigInt(v)),
      minStepBps: BigInt(x.min_step_bps),
      spacingMultBps: tiers(x.spacing_mult_bps),
      strikesPerSide: tiers(x.strikes_per_side),
      maxPerSide: BigInt(x.max_per_side),
      coverageSigmaBps: BigInt(x.coverage_sigma_bps),
      ivFloorBps: BigInt(x.iv_floor_bps),
      ivCeilingBps: BigInt(x.iv_ceiling_bps),
      rvFallbackMultBps: BigInt(x.rv_fallback_mult_bps),
      tierAMinContracts: BigInt(x.tier_a_min_contracts),
      tierBMinContracts: BigInt(x.tier_b_min_contracts),
    };
  }

  async activePolicy() {
    const r = await this.pool.query("SELECT * FROM strike_policy WHERE active ORDER BY id DESC LIMIT 1");
    if (!r.rows[0]) throw new Error("no active strike_policy row");
    return this.toPolicy(r.rows[0]);
  }

  async policy(id: number) {
    const r = await this.pool.query("SELECT * FROM strike_policy WHERE id = $1", [id]);
    if (!r.rows[0]) throw new Error(`no strike_policy ${id}`);
    return this.toPolicy(r.rows[0]);
  }

  async corporateActions(date: IsoDate): Promise<CorporateActionRow[]> {
    const r = await this.pool.query("SELECT symbol, effective_date, kind, skip_markets FROM corporate_actions WHERE effective_date = $1", [date]);
    return r.rows.map((x) => ({ symbol: x.symbol, effectiveDate: x.effective_date, kind: x.kind, skipMarkets: x.skip_markets }));
  }

  async upsertCalendar(rows: CalendarRow[]) {
    for (const row of rows) {
      await this.pool.query(
        `INSERT INTO trading_calendar (trading_date, open_time, close_time, is_half_day) VALUES ($1,$2,$3,$4)
         ON CONFLICT (trading_date) DO UPDATE SET open_time = EXCLUDED.open_time, close_time = EXCLUDED.close_time, is_half_day = EXCLUDED.is_half_day`,
        [row.tradingDate, ts(row.openTime), ts(row.closeTime), row.isHalfDay],
      );
    }
    return rows.length;
  }

  async calendarRows(): Promise<CalendarRow[]> {
    const r = await this.pool.query("SELECT * FROM trading_calendar ORDER BY trading_date");
    return r.rows.map((x) => ({ tradingDate: x.trading_date, openTime: unix(x.open_time)!, closeTime: unix(x.close_time)!, isHalfDay: x.is_half_day }));
  }

  private toOracle(x: Record<string, any>): OracleUpdateRow {
    return {
      symbol: x.symbol, tradingDate: x.trading_date, purpose: x.purpose, targetTime: unix(x.target_time)!,
      publishTime: unix(x.publish_time)!, priceRaw: BigInt(x.price_raw), expo: x.expo, conf: BigInt(x.conf),
      vaa: new Uint8Array(x.vaa), fetchedAt: unix(x.fetched_at)!,
    };
  }

  async getOracleUpdate(symbol: string, date: IsoDate, purpose: Purpose) {
    const r = await this.pool.query("SELECT * FROM oracle_updates WHERE symbol=$1 AND trading_date=$2 AND purpose=$3", [symbol, date, purpose]);
    return r.rows[0] ? this.toOracle(r.rows[0]) : null;
  }

  async putOracleUpdate(row: OracleUpdateRow) {
    await this.pool.query(
      `INSERT INTO oracle_updates (symbol, trading_date, purpose, target_time, publish_time, price_raw, expo, conf, vaa, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [row.symbol, row.tradingDate, row.purpose, ts(row.targetTime), ts(row.publishTime), row.priceRaw.toString(), row.expo,
        row.conf.toString(), Buffer.from(row.vaa), ts(row.fetchedAt)],
    );
    return (await this.getOracleUpdate(row.symbol, row.tradingDate, row.purpose))!;
  }

  private toClose(x: Record<string, any>): OfficialCloseRow {
    return {
      symbol: x.symbol, tradingDate: x.trading_date, priceCents: BigInt(x.price_cents), massiveCents: BigInt(x.massive_cents),
      massiveAt: unix(x.massive_at)!, databentoCents: BigInt(x.databento_cents), databentoAt: unix(x.databento_at)!,
    };
  }

  async getOfficialClose(symbol: string, date: IsoDate) {
    const r = await this.pool.query("SELECT * FROM official_closes WHERE symbol=$1 AND trading_date=$2", [symbol, date]);
    return r.rows[0] ? this.toClose(r.rows[0]) : null;
  }

  async putOfficialClose(row: OfficialCloseRow) {
    await this.pool.query(
      `INSERT INTO official_closes (symbol, trading_date, price_cents, massive_cents, massive_at, databento_cents, databento_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [row.symbol, row.tradingDate, row.priceCents.toString(), row.massiveCents.toString(), ts(row.massiveAt),
        row.databentoCents.toString(), ts(row.databentoAt)],
    );
    return (await this.getOfficialClose(row.symbol, row.tradingDate))!;
  }

  async officialClosesBefore(symbol: string, date: IsoDate, n: number) {
    const r = await this.pool.query(
      "SELECT * FROM official_closes WHERE symbol=$1 AND trading_date < $2 ORDER BY trading_date DESC LIMIT $3",
      [symbol, date, n],
    );
    return r.rows.map((x) => this.toClose(x));
  }

  private toInputs(x: Record<string, any>): StrikeInputsRow {
    return {
      symbol: x.symbol, tradingDate: x.trading_date, prevCloseCents: BigInt(x.prev_close_cents),
      ivBps: x.iv_bps === null ? null : BigInt(x.iv_bps), ivSource: x.iv_source, rv20Bps: BigInt(x.rv20_bps),
      volUsedBps: BigInt(x.vol_used_bps), volBasis: x.vol_basis, liquidityContracts5d: BigInt(x.liquidity_contracts_5d),
      liquidityTier: x.liquidity_tier, move1dCents: BigInt(x.move_1d_cents), stepCents: BigInt(x.step_cents),
      perSide: BigInt(x.per_side), strikesCents: (x.strikes_cents as string[]).map((s) => BigInt(s)),
      policyId: x.policy_id, computedAt: unix(x.computed_at)!,
    };
  }

  async getStrikeInputs(symbol: string, date: IsoDate) {
    const r = await this.pool.query("SELECT * FROM strike_inputs WHERE symbol=$1 AND trading_date=$2", [symbol, date]);
    return r.rows[0] ? this.toInputs(r.rows[0]) : null;
  }

  async putStrikeInputs(x: StrikeInputsRow) {
    await this.pool.query(
      `INSERT INTO strike_inputs (symbol, trading_date, prev_close_cents, iv_bps, iv_source, rv20_bps, vol_used_bps, vol_basis,
         liquidity_contracts_5d, liquidity_tier, move_1d_cents, step_cents, per_side, strikes_cents, policy_id, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT DO NOTHING`,
      [x.symbol, x.tradingDate, x.prevCloseCents.toString(), x.ivBps?.toString() ?? null, x.ivSource, x.rv20Bps.toString(),
        x.volUsedBps.toString(), x.volBasis, x.liquidityContracts5d.toString(), x.liquidityTier, x.move1dCents.toString(),
        x.stepCents.toString(), x.perSide.toString(), x.strikesCents.map((s) => s.toString()), x.policyId, ts(x.computedAt)],
    );
    return (await this.getStrikeInputs(x.symbol, x.tradingDate))!;
  }

  async contractsByDate(symbol: string, dates: IsoDate[]) {
    const out = new Map<IsoDate, bigint>();
    for (const d of dates) out.set(d, 0n);
    if (dates.length === 0) return out;
    const r = await this.pool.query(
      `SELECT (f.block_time AT TIME ZONE 'America/New_York')::date::text AS d, SUM(f.qty)::text AS q
         FROM fills f JOIN markets m ON m.pda = f.market_pda
        WHERE m.symbol = $1 AND (f.block_time AT TIME ZONE 'America/New_York')::date = ANY($2::date[])
        GROUP BY 1`,
      [symbol, dates],
    );
    for (const x of r.rows) out.set(x.d, BigInt(x.q));
    return out;
  }

  async hasAnyFills(symbol: string) {
    const r = await this.pool.query("SELECT 1 FROM fills f JOIN markets m ON m.pda = f.market_pda WHERE m.symbol = $1 LIMIT 1", [symbol]);
    return r.rowCount! > 0;
  }

  private toRun(x: Record<string, any>): JobRunRow {
    return {
      id: Number(x.id), job: x.job, tradingDate: x.trading_date, symbol: x.symbol, attempt: x.attempt, status: x.status,
      detail: x.detail, txSigs: x.tx_sigs ?? [], startedAt: unix(x.started_at)!, finishedAt: unix(x.finished_at),
    };
  }

  async startJobRun(job: JobName, date: IsoDate, symbol: string | null) {
    const r = await this.pool.query(
      `INSERT INTO job_runs (job, trading_date, symbol, attempt, status, started_at)
       VALUES ($1, $2, $3, (SELECT COALESCE(MAX(attempt),0)+1 FROM job_runs WHERE job=$1 AND trading_date=$2 AND symbol IS NOT DISTINCT FROM $3), 'RUNNING', now())
       RETURNING *`,
      [job, date, symbol],
    );
    return this.toRun(r.rows[0]);
  }

  async finishJobRun(id: number, status: JobStatus, detail?: Record<string, unknown>, txSigs?: string[]) {
    await this.pool.query(
      "UPDATE job_runs SET status=$2, detail=$3, tx_sigs=$4, finished_at=now() WHERE id=$1",
      [id, status, detail ? JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : null, txSigs ?? []],
    );
  }

  async jobRuns(date: IsoDate, job?: JobName) {
    const r = await this.pool.query(
      "SELECT * FROM job_runs WHERE trading_date=$1 AND ($2::text IS NULL OR job=$2) ORDER BY id",
      [date, job ?? null],
    );
    return r.rows.map((x) => this.toRun(x));
  }

  private toAlert(x: Record<string, any>): AlertRow {
    return { id: Number(x.id), severity: x.severity, code: x.code, symbol: x.symbol, tradingDate: x.trading_date, message: x.message, createdAt: unix(x.created_at)! };
  }

  async raiseAlert(a: Omit<AlertRow, "id" | "createdAt">) {
    const open = await this.pool.query(
      `SELECT * FROM alerts WHERE acked_at IS NULL AND code=$1 AND severity=$2
         AND symbol IS NOT DISTINCT FROM $3 AND trading_date IS NOT DISTINCT FROM $4 LIMIT 1`,
      [a.code, a.severity, a.symbol, a.tradingDate],
    );
    if (open.rows[0]) return this.toAlert(open.rows[0]);
    const r = await this.pool.query(
      "INSERT INTO alerts (severity, code, symbol, trading_date, message) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [a.severity, a.code, a.symbol, a.tradingDate, a.message],
    );
    return this.toAlert(r.rows[0]);
  }

  async alerts() {
    const r = await this.pool.query("SELECT * FROM alerts ORDER BY id");
    return r.rows.map((x) => this.toAlert(x));
  }

  /** Session-level advisory lock on a dedicated connection, held until released. */
  async tryLock(key: string) {
    const c = await this.pool.connect();
    try {
      const r = await c.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok", [key]);
      if (!r.rows[0]?.ok) {
        c.release();
        return null;
      }
    } catch (e) {
      c.release();
      throw e;
    }
    return async () => {
      try {
        await c.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      } finally {
        c.release();
      }
    };
  }

  async chainSignatures(date: IsoDate) {
    const r = await this.pool.query(
      "SELECT DISTINCT signature FROM chain_events WHERE (block_time AT TIME ZONE 'America/New_York')::date = $1",
      [date],
    );
    return new Set(r.rows.map((x) => x.signature as string));
  }

  async fills(date: IsoDate): Promise<FillRow[]> {
    const r = await this.pool.query(
      "SELECT * FROM fills WHERE (block_time AT TIME ZONE 'America/New_York')::date = $1 ORDER BY market_pda, seq",
      [date],
    );
    return r.rows.map((x) => ({
      signature: x.signature, eventIndex: x.event_index, marketPda: x.market_pda, seq: big(x.seq)!, qty: big(x.qty)!,
      priceCents: x.price_cents, blockTime: unix(x.block_time)!,
    }));
  }

  async putReconcileReport(r: ReconcileReport) {
    await this.pool.query(
      "INSERT INTO reconcile_reports (trading_date, missing_count, mismatch_count, invariant_breaks, diff) VALUES ($1,$2,$3,$4,$5)",
      [r.tradingDate, r.missingCount, r.mismatchCount, r.invariantBreaks,
        JSON.stringify(r.diff, (_k, v) => (typeof v === "bigint" ? v.toString() : v))],
    );
  }
}
