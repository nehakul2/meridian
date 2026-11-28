/**
 * Builds the rules' Snapshot from Postgres (read replica is fine), Redis (`md:slot`), RPC (the
 * newest Meridian transaction) and each WS gateway's /healthz. Read-only everywhere: the Monitor
 * writes only `alerts` (spec 3.1 C9).
 */
import type pg from "pg";
import type { Redis } from "ioredis";
import { etDate, IsoDate } from "../../automation/src/time.js";
import type { GatewayHealth, MarketRow, Snapshot, TickerDayRow } from "./rules.js";

export interface Sources {
  pool: pg.Pool;
  redis: Redis | null;
  /** Newest confirmed transaction that touched the program, or null if none / RPC unavailable. */
  newestProgramTx(): Promise<{ slot: number; blockTime: number } | null>;
  gateways: { id: string; url: string }[];
  fetchFn?: typeof fetch;
}

const epoch = (v: Date | null) => (v ? Math.floor(v.getTime() / 1000) : null);

export class Collector {
  private readonly prevErrors = new Map<string, number>();
  constructor(private readonly s: Sources) {}

  async snapshot(now: number, date: IsoDate = etDate(now)): Promise<Snapshot> {
    const q = <T extends pg.QueryResultRow>(sql: string, args: unknown[] = []) => this.s.pool.query<T>(sql, args).then((r) => r.rows);
    const [cal] = await q<{ close_time: Date }>("SELECT close_time FROM trading_calendar WHERE trading_date = $1::date", [date]);
    const tickers = (await q<{ symbol: string }>("SELECT symbol FROM tickers WHERE enabled ORDER BY symbol")).map((r) => r.symbol);
    const skipped = (await q<{ symbol: string }>(
      `SELECT DISTINCT symbol FROM job_runs WHERE job = 'MORNING' AND trading_date = $1::date AND status = 'SKIPPED' AND symbol IS NOT NULL`,
      [date],
    )).map((r) => r.symbol);
    const tickerDays: TickerDayRow[] = (await q<{
      symbol: string; status: TickerDayRow["status"]; close_time: Date; recorded_at: Date | null; finalized_at: Date | null;
      close_price_raw: string | null; close_expo: number | null; close_conf: string | null;
    }>(
      `SELECT symbol, status, close_time, recorded_at, finalized_at, close_price_raw, close_expo, close_conf
         FROM ticker_days WHERE trading_date = $1::date`,
      [date],
    )).map((r) => ({
      symbol: r.symbol, status: r.status, closeTime: epoch(r.close_time)!, recordedAt: epoch(r.recorded_at), finalizedAt: epoch(r.finalized_at),
      priceRaw: r.close_price_raw === null ? null : BigInt(r.close_price_raw), expo: r.close_expo,
      conf: r.close_conf === null ? null : BigInt(r.close_conf),
    }));
    const markets: MarketRow[] = (await q<{ symbol: string; strike_cents: string; status: MarketRow["status"] }>(
      "SELECT symbol, strike_cents, status FROM markets WHERE trading_date = $1::date",
      [date],
    )).map((r) => ({ symbol: r.symbol, strikeCents: BigInt(r.strike_cents), status: r.status }));
    const settleReason = Object.fromEntries((await q<{ symbol: string; reason: string | null }>(
      `SELECT DISTINCT ON (symbol) symbol, coalesce(detail->>'detail', detail->>'error', status) AS reason
         FROM job_runs WHERE job = 'SETTLE' AND trading_date = $1::date AND symbol IS NOT NULL
        ORDER BY symbol, started_at DESC, id DESC`,
      [date],
    )).map((r) => [r.symbol, r.reason ?? "unknown"]));
    const [rec] = await q<{ invariant_breaks: number; diff: unknown }>(
      "SELECT invariant_breaks, diff FROM reconcile_reports WHERE trading_date = $1::date ORDER BY id DESC LIMIT 1",
      [date],
    );

    let processedSlot: number | null = null;
    if (this.s.redis) {
      const v = await this.s.redis.get("md:slot");
      processedSlot = v === null ? null : Number(v);
    }
    const newestProgramTx = await this.s.newestProgramTx().catch(() => null);

    return {
      now, date, calendar: cal ? { closeTime: epoch(cal.close_time)! } : null, tickers, skipped, tickerDays, markets, settleReason,
      indexer: { processedSlot, newestProgramTx },
      gateways: await Promise.all(this.s.gateways.map((g) => this.gateway(g))),
      reconcile: rec ? { invariantBreaks: rec.invariant_breaks, detail: JSON.stringify(rec.diff).slice(0, 300) } : null,
    };
  }

  private async gateway(g: { id: string; url: string }): Promise<GatewayHealth> {
    const f = this.s.fetchFn ?? fetch;
    try {
      const r = await f(g.url, { signal: AbortSignal.timeout(3_000) });
      if (!r.ok) return { id: g.id, ok: false, detail: `HTTP ${r.status}` };
      const h = (await r.json()) as { ok?: boolean; errors?: number };
      const prev = this.prevErrors.get(g.id);
      if (typeof h.errors === "number") this.prevErrors.set(g.id, h.errors);
      return { id: g.id, ok: h.ok !== false, errors: h.errors, prevErrors: prev, detail: h.ok === false ? "Redis subscription not ready" : undefined };
    } catch (e) {
      this.prevErrors.delete(g.id);
      return { id: g.id, ok: false, detail: (e as Error).message };
    }
  }
}

/** JSON-RPC: newest signature for the program (getSignaturesForAddress, limit 1). */
export function rpcNewestProgramTx(rpcUrl: string, programId: string, fetchFn: typeof fetch = fetch) {
  return async () => {
    const r = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [programId, { limit: 1, commitment: "confirmed" }] }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await r.json()) as { result?: { slot: number; blockTime: number | null }[] };
    const s = body.result?.[0];
    return s && s.blockTime ? { slot: s.slot, blockTime: s.blockTime } : null;
  };
}
