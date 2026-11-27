/**
 * MER-53 / MER-54: writes chain-derived Postgres tables (spec 5) from `md:events`.
 *
 * - One whole instruction per transaction. `chain_events` is inserted first with
 *   ON CONFLICT DO NOTHING; only newly inserted events are applied, so replaying the
 *   stream (twice, or after a crash) leaves every table unchanged (IDX-03).
 * - Per-market `seq` continuity: an instruction that skips seqs is held, and a backfill
 *   request goes to the Indexer; the held instructions apply in order once the gap is
 *   filled (IDX-04).
 * - Rows go in at `confirmed`; a `Finalized` control entry promotes them, and a `Dropped`
 *   one deletes the signature's events and rebuilds the affected markets (orders, fills,
 *   mint/merge/redeem, candles, counters and positions) from `chain_events` (IDX-05).
 * - Positions use the shared engine (services/shared/src/positions.ts), so they match the
 *   Indexer's `md:pos`.
 */
import type { Pool, PoolClient } from "pg";
import {
  ChainEvent, isMarketScoped, StreamEntry,
} from "../../shared/src/events.js";
import {
  applyInstruction, Applied, emptyPosition, MarketState, needs, OrderState, PositionState,
} from "../../shared/src/positions.js";

export interface Backfiller {
  request(market: string, fromSeq: bigint, toSeq: bigint): Promise<void>;
}

export interface WriterOptions {
  /** The market_creator key: markets it creates are stored as created_by = 'AUTO'. */
  marketCreator?: string;
  log?: { warn(msg: string, extra?: Record<string, unknown>): void; info?(msg: string, extra?: Record<string, unknown>): void };
}

const ts = (s: number | null | undefined) => (s == null ? null : new Date(s * 1000).toISOString());

/** YYYYMMDD → YYYY-MM-DD. */
export function isoDate(d: number | string): string {
  const s = String(d);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** 16:00 America/New_York on `date`, as an ISO timestamp (fallback when the calendar lacks the day). */
export function defaultClose(date: string): string {
  for (const offset of [4, 5]) {
    const t = new Date(`${date}T${String(16 + offset).padStart(2, "0")}:00:00Z`);
    const hour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(t);
    if (Number(hour) === 16) return t.toISOString();
  }
  return new Date(`${date}T21:00:00Z`).toISOString();
}

const seqOf = (e: ChainEvent) => BigInt(e.payload.seq as string);

interface Held {
  group: ChainEvent[];
  done: () => void;
}

export class PgWriter {
  private readonly lastSeq = new Map<string, bigint>();
  private readonly held = new Map<string, Held[]>();
  private readonly requested = new Set<string>();
  private readonly log: NonNullable<WriterOptions["log"]>;

  constructor(private readonly pool: Pool, private readonly backfill: Backfiller, private readonly o: WriterOptions = {}) {
    this.log = o.log ?? { warn: (m, x) => console.warn(JSON.stringify({ level: "warn", msg: m, ...x })) };
  }

  /** Instructions waiting for a seq gap to fill, per market. */
  heldCount(market?: string): number {
    if (market) return this.held.get(market)?.length ?? 0;
    return [...this.held.values()].reduce((a, h) => a + h.length, 0);
  }

  private async knownSeq(m: string): Promise<bigint> {
    const cached = this.lastSeq.get(m);
    if (cached != null) return cached;
    const r = await this.pool.query("SELECT COALESCE(MAX(seq), 0) AS s FROM chain_events WHERE market_pda = $1", [m]);
    const s = BigInt(r.rows[0].s);
    this.lastSeq.set(m, s);
    return s;
  }

  /**
   * Handles one whole instruction or a control entry. `done` is called once the entry's
   * effects are committed (immediately, or later for a held instruction), so the consumer
   * can acknowledge it.
   */
  async handle(entry: StreamEntry | ChainEvent[], done: () => void = () => undefined): Promise<void> {
    if (!Array.isArray(entry)) {
      if (entry.type === "control") {
        await (entry.kind === "Finalized" ? this.finalize(entry.sig) : this.dropped(entry.sig));
        done();
        return;
      }
      return this.handle([entry as ChainEvent], done);
    }
    const group = entry;
    if (group.length === 0) return done();
    if (!isMarketScoped(group[0]!)) {
      await this.apply(group);
      return done();
    }
    const m = String(group[0]!.payload.market);
    const known = await this.knownSeq(m);
    const first = seqOf(group[0]!);
    const last = seqOf(group.at(-1)!);
    if (last <= known) {
      // Already applied (replay): chain_events conflict makes it a no-op, but skip the work.
      await this.apply(group);
      return done();
    }
    if (first > known + 1n) {
      const h = this.held.get(m) ?? [];
      if (!h.some((x) => seqOf(x.group[0]!) === first)) h.push({ group, done });
      h.sort((a, b) => Number(seqOf(a.group[0]!) - seqOf(b.group[0]!)));
      this.held.set(m, h);
      const key = `${m}:${known + 1n}`;
      if (!this.requested.has(key)) {
        this.requested.add(key);
        this.log.warn("seq gap; requesting backfill", { market: m, from: String(known + 1n), to: String(first - 1n) });
        await this.backfill.request(m, known + 1n, first - 1n);
      }
      return;
    }
    await this.apply(group);
    done();
    // Drain held instructions that are now contiguous.
    const h = this.held.get(m);
    while (h && h.length > 0 && seqOf(h[0]!.group[0]!) <= (await this.knownSeq(m)) + 1n) {
      const next = h.shift()!;
      await this.apply(next.group);
      next.done();
    }
  }

  /** Applies one instruction in one transaction. Returns false when it was already applied. */
  async apply(group: ChainEvent[], opts: { replay?: boolean } = {}): Promise<boolean> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const ok = await this.applyIn(c, group, opts.replay ?? false);
      await c.query("COMMIT");
      if (ok && isMarketScoped(group[0]!)) {
        const m = String(group[0]!.payload.market);
        const s = seqOf(group.at(-1)!);
        if (s > (this.lastSeq.get(m) ?? 0n)) this.lastSeq.set(m, s);
      }
      return ok;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }

  private async applyIn(c: PoolClient, group: ChainEvent[], replay: boolean): Promise<boolean> {
    if (!replay) {
      let inserted = 0;
      for (const e of group) {
        const r = await c.query(
          `INSERT INTO chain_events (signature, ix_index, event_index, slot, block_time, market_pda, seq, kind, payload, commitment)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
          [e.sig, e.ix, e.ev, e.slot, ts(e.blockTime), String(e.payload.market), String(e.payload.seq), e.kind, e.payload, e.commitment],
        );
        inserted += r.rowCount ?? 0;
      }
      if (inserted === 0) return false;
      if (inserted !== group.length) throw new Error(`partial instruction ${group[0]!.sig}:${group[0]!.ix}`);
    }
    if (!isMarketScoped(group[0]!)) {
      for (const e of group) await this.tickerDayEvent(c, e);
      return true;
    }
    const m = String(group[0]!.payload.market);
    for (const e of group) if (e.kind === "MarketCreated") await this.marketCreated(c, e);

    const state = await this.loadState(c, m, group);
    const applied = applyInstruction(state, group);
    await this.persist(c, m, group, state, applied);
    return true;
  }

  private async marketCreated(c: PoolClient, e: ChainEvent) {
    const p = e.payload;
    const date = isoDate(Number(p.date));
    const cal = await c.query("SELECT close_time FROM trading_calendar WHERE trading_date = $1", [date]);
    const close = cal.rowCount ? cal.rows[0].close_time : defaultClose(date);
    await c.query(
      `INSERT INTO ticker_days (pda, symbol, trading_date, close_time, status) VALUES ($1,$2,$3,$4,'OPEN')
       ON CONFLICT DO NOTHING`,
      [String(p.ticker_day), String(p.ticker), date, close],
    );
    const by = this.o.marketCreator && p.created_by === this.o.marketCreator ? "AUTO" : String(p.created_by);
    await c.query(
      `INSERT INTO markets (pda, ticker_day_pda, symbol, trading_date, strike_cents, yes_mint, no_mint, vault, book, status, created_by, created_slot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'TRADING',$10,$11)
       ON CONFLICT (pda) DO UPDATE SET status = 'TRADING', outcome = NULL, book = EXCLUDED.book, settled_slot = NULL,
         pairs_outstanding = 0, total_volume_contracts = 0`,
      [String(p.market), String(p.ticker_day), String(p.ticker), date, String(p.strike_cents), String(p.yes_mint),
        String(p.no_mint), String(p.vault), String(p.book), by, e.slot],
    );
  }

  private async ensureTickerDay(c: PoolClient, e: ChainEvent) {
    const p = e.payload;
    const date = isoDate(Number(p.date));
    const cal = await c.query("SELECT close_time FROM trading_calendar WHERE trading_date = $1", [date]);
    await c.query(
      `INSERT INTO ticker_days (pda, symbol, trading_date, close_time, status) VALUES ($1,$2,$3,$4,'OPEN') ON CONFLICT DO NOTHING`,
      [String(p.market), String(p.ticker), date, cal.rowCount ? cal.rows[0].close_time : defaultClose(date)],
    );
  }

  private async tickerDayEvent(c: PoolClient, e: ChainEvent) {
    const p = e.payload;
    const td = String(p.market);
    switch (e.kind) {
      case "CloseRecorded":
        await this.ensureTickerDay(c, e);
        await c.query(
          `UPDATE ticker_days SET status = 'PROVISIONAL', recorded_at = $2, close_price_raw = $3::bigint, close_expo = $4::int,
             close_conf = $5, close_price = ($3::bigint::numeric * power(10::numeric, $4::int)), publish_time = $6,
             recorded_by = $7, recorded_sig = $8
           WHERE pda = $1`,
          [td, ts(e.blockTime), String(p.price), Number(p.expo), String(p.conf), ts(Number(p.publish_time)), String(p.by), e.sig],
        );
        break;
      case "DisputeRaised":
        await c.query("UPDATE ticker_days SET status = 'DISPUTED' WHERE pda = $1", [td]);
        await c.query(
          `INSERT INTO disputes (ticker_day_pda, raised_by, bond_micro, evidence_hash, raised_at, old_price_raw, raised_sig)
           SELECT $1, $2, $3, $4, $5, COALESCE(close_price_raw, 0), $6 FROM ticker_days WHERE pda = $1
           ON CONFLICT DO NOTHING`,
          [td, String(p.by), String(p.bond), String(p.evidence_hash), ts(e.blockTime), e.sig],
        );
        break;
      case "DisputeResolved": {
        const corrected = p.result === "CORRECTED";
        await c.query(
          `UPDATE disputes SET result = $2, new_price_raw = $3, resolved_at = $4, resolved_sig = $5 WHERE ticker_day_pda = $1`,
          [td, String(p.result), corrected ? String(p.new_price) : null, ts(e.blockTime), e.sig],
        );
        if (corrected) {
          await c.query(
            `UPDATE ticker_days SET original_price_raw = $2, close_price_raw = $3::bigint,
               close_price = ($3::bigint::numeric * power(10::numeric, COALESCE(close_expo, 0))) WHERE pda = $1`,
            [td, String(p.old_price), String(p.new_price)],
          );
        }
        break;
      }
      case "CloseFinalized":
        await c.query(
          `UPDATE ticker_days SET status = 'FINAL', final_basis = $2, finalized_at = $3, close_price_raw = $4::bigint,
             close_price = ($4::bigint::numeric * power(10::numeric, COALESCE(close_expo, 0))) WHERE pda = $1`,
          [td, String(p.basis), ts(e.blockTime), String(p.price)],
        );
        if (p.basis === "DEADLINE") {
          await c.query(`UPDATE disputes SET result = 'DEADLINE', resolved_at = $2, resolved_sig = $3 WHERE ticker_day_pda = $1 AND result IS NULL`, [td, ts(e.blockTime), e.sig]);
        }
        break;
      default:
        break; // Paused / Unpaused: chain_events only
    }
  }

  private async loadState(c: PoolClient, m: string, group: ChainEvent[]): Promise<MarketState> {
    const need = needs(group);
    const state: MarketState = { orders: new Map(), positions: new Map() };
    if (need.orders.size > 0) {
      const r = await c.query("SELECT * FROM orders WHERE market_pda = $1 AND order_id = ANY($2::bigint[])", [m, [...need.orders].map(String)]);
      for (const row of r.rows) state.orders.set(BigInt(row.order_id), rowToOrder(row));
    }
    if (need.owners.size > 0) {
      const owners = [...need.owners];
      const r = await c.query("SELECT * FROM positions WHERE market_pda = $1 AND owner = ANY($2::text[])", [m, owners]);
      const pend = await c.query(
        `SELECT owner, COALESCE(SUM(qty_original - qty_filled), 0) AS q FROM orders
         WHERE market_pda = $1 AND owner = ANY($2::text[]) AND tag = 'BUY_NO' AND status IN ('OPEN','PARTIAL') GROUP BY owner`,
        [m, owners],
      );
      const pending = new Map(pend.rows.map((x) => [x.owner as string, BigInt(x.q)]));
      for (const row of r.rows) state.positions.set(row.owner, rowToPosition(row, pending.get(row.owner) ?? 0n));
    }
    return state;
  }

  private async persist(c: PoolClient, m: string, group: ChainEvent[], state: MarketState, a: Applied) {
    for (const e of group) {
      const p = e.payload;
      if (e.kind === "MarketSettled") {
        await c.query("UPDATE markets SET status = 'SETTLED', outcome = $2, settled_slot = $3 WHERE pda = $1", [m, String(p.outcome), e.slot]);
      } else if (e.kind === "MarketVoided") {
        await c.query("UPDATE markets SET status = 'VOID', outcome = 'VOID', settled_slot = $2 WHERE pda = $1", [m, e.slot]);
      } else if (e.kind === "BookClosed") {
        await c.query("UPDATE markets SET book = NULL WHERE pda = $1", [m]);
      }
    }
    if (a.pairsDelta !== 0n || a.volumeDelta !== 0n) {
      await c.query(
        "UPDATE markets SET pairs_outstanding = pairs_outstanding + $2, total_volume_contracts = total_volume_contracts + $3 WHERE pda = $1",
        [m, a.pairsDelta.toString(), a.volumeDelta.toString()],
      );
    }
    for (const id of a.orders) {
      const o = state.orders.get(id)!;
      await c.query(
        `INSERT INTO orders (market_pda, order_id, owner, side, price_cents, qty_original, qty_filled, tif, tag, intent, status,
           cancel_reason, placed_sig, placed_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (market_pda, order_id) DO UPDATE SET qty_filled = EXCLUDED.qty_filled, status = EXCLUDED.status,
           cancel_reason = EXCLUDED.cancel_reason, updated_at = EXCLUDED.updated_at`,
        [m, id.toString(), o.owner, o.side, o.price, o.qtyOriginal.toString(), o.qtyFilled.toString(), o.tif, o.tag, o.intent,
          o.status, o.cancelReason, o.placedSig, ts(o.placedAt), ts(o.updatedAt)],
      );
    }
    const buckets = new Set<string>();
    for (const f of a.fills) {
      await c.query(
        `INSERT INTO fills (signature, event_index, market_pda, seq, maker_order_id, maker, taker, taker_side, price_cents, qty,
           taker_fee_micro, maker_intent, taker_intent, slot, block_time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING`,
        [f.sig, f.ev, m, f.seq.toString(), f.makerOrderId.toString(), f.maker, f.taker, f.takerSide, f.price, f.qty.toString(),
          f.takerFee.toString(), f.makerIntent, f.takerIntent, f.slot, ts(f.blockTime)],
      );
      buckets.add(new Date(Math.floor(f.blockTime / 60) * 60_000).toISOString());
    }
    for (const b of buckets) {
      // Recomputed from fills, so it is the same however often it runs.
      await c.query(
        `INSERT INTO candles_1m (market_pda, bucket, o, h, l, c, volume)
         SELECT $1, $2::timestamptz, (array_agg(price_cents ORDER BY seq))[1], MAX(price_cents), MIN(price_cents),
                (array_agg(price_cents ORDER BY seq DESC))[1], SUM(qty)
         FROM fills WHERE market_pda = $1 AND block_time >= $2::timestamptz AND block_time < $2::timestamptz + interval '1 minute'
         ON CONFLICT (market_pda, bucket) DO UPDATE SET o = EXCLUDED.o, h = EXCLUDED.h, l = EXCLUDED.l, c = EXCLUDED.c, volume = EXCLUDED.volume`,
        [m, b],
      );
    }
    for (const r of a.mmr) {
      await c.query(
        `INSERT INTO mint_merge_redeem (signature, event_index, market_pda, owner, kind, via, yes_qty, no_qty, usdc_micro, block_time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [r.sig, r.ev, m, r.owner, r.kind, r.via, r.yesQty.toString(), r.noQty.toString(), r.usdc.toString(), ts(r.blockTime)],
      );
    }
    for (const o of a.owners) {
      const p = state.positions.get(o)!;
      await c.query(
        `INSERT INTO positions (owner, market_pda, yes_qty, no_qty, yes_cost_micro, no_cost_micro, realized_pnl_micro,
           ledger_free_usdc, ledger_free_yes, redeemed, last_seq, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (owner, market_pda) DO UPDATE SET yes_qty = EXCLUDED.yes_qty, no_qty = EXCLUDED.no_qty,
           yes_cost_micro = EXCLUDED.yes_cost_micro, no_cost_micro = EXCLUDED.no_cost_micro,
           realized_pnl_micro = EXCLUDED.realized_pnl_micro, ledger_free_usdc = EXCLUDED.ledger_free_usdc,
           ledger_free_yes = EXCLUDED.ledger_free_yes, redeemed = EXCLUDED.redeemed, last_seq = EXCLUDED.last_seq,
           updated_at = EXCLUDED.updated_at`,
        [o, m, p.yes.toString(), p.no.toString(), p.yesCost.toString(), p.noCost.toString(), p.realized.toString(),
          p.ledgerUsdc.toString(), p.ledgerYes.toString(), p.redeemed, p.lastSeq.toString(), ts(p.updatedAt) ?? new Date(0).toISOString()],
      );
    }
  }

  private async finalize(sig: string) {
    await this.pool.query("UPDATE chain_events SET commitment = 'finalized' WHERE signature = $1", [sig]);
  }

  /** A confirmed signature that never finalized: delete it and rebuild what it touched. */
  private async dropped(sig: string) {
    const r = await this.pool.query("DELETE FROM chain_events WHERE signature = $1 RETURNING market_pda, seq", [sig]);
    if (r.rowCount === 0) return;
    const markets = new Set<string>();
    const tdays = new Set<string>();
    for (const row of r.rows) (BigInt(row.seq) > 0n ? markets : tdays).add(row.market_pda);
    this.log.warn("dropped signature removed", { sig, markets: [...markets], tickerDays: [...tdays] });
    for (const m of markets) await this.rebuildMarket(m);
    for (const td of tdays) await this.rebuildTickerDay(td);
  }

  /** Rebuilds one market's derived rows by replaying its `chain_events` in seq order. */
  async rebuildMarket(m: string): Promise<void> {
    const ev = await this.pool.query("SELECT * FROM chain_events WHERE market_pda = $1 ORDER BY seq, signature, ix_index, event_index", [m]);
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      for (const t of ["positions", "fills", "mint_merge_redeem", "candles_1m", "orders"]) {
        await c.query(`DELETE FROM ${t} WHERE market_pda = $1`, [m]);
      }
      await c.query("UPDATE markets SET pairs_outstanding = 0, total_volume_contracts = 0 WHERE pda = $1", [m]);
      const events = ev.rows.map(rowToEvent);
      const groups: ChainEvent[][] = [];
      for (const e of events) {
        const g = groups.at(-1);
        if (g && g[0]!.sig === e.sig && g[0]!.ix === e.ix) g.push(e);
        else groups.push([e]);
      }
      for (const g of groups) await this.applyIn(c, g, true);
      await c.query("COMMIT");
      this.lastSeq.set(m, events.length ? seqOf(events.at(-1)!) : 0n);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }

  private async rebuildTickerDay(td: string): Promise<void> {
    const ev = await this.pool.query("SELECT * FROM chain_events WHERE market_pda = $1 ORDER BY slot, signature, ix_index, event_index", [td]);
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("DELETE FROM disputes WHERE ticker_day_pda = $1", [td]);
      await c.query(
        `UPDATE ticker_days SET status = 'OPEN', final_basis = NULL, recorded_at = NULL, finalized_at = NULL, original_price_raw = NULL,
           close_price = NULL, close_price_raw = NULL, close_expo = NULL, close_conf = NULL, publish_time = NULL, recorded_by = NULL,
           recorded_sig = NULL WHERE pda = $1`,
        [td],
      );
      for (const row of ev.rows) await this.tickerDayEvent(c, rowToEvent(row));
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
}

function rowToEvent(row: Record<string, unknown>): ChainEvent {
  return {
    sig: String(row.signature), ix: Number(row.ix_index), ev: Number(row.event_index), n: 0, slot: Number(row.slot),
    blockTime: row.block_time ? Math.floor((row.block_time as Date).getTime() / 1000) : null,
    commitment: row.commitment as ChainEvent["commitment"], kind: row.kind as ChainEvent["kind"],
    payload: row.payload as ChainEvent["payload"],
  };
}

const unix = (d: unknown) => (d ? Math.floor((d as Date).getTime() / 1000) : 0);

function rowToOrder(r: Record<string, unknown>): OrderState {
  return {
    market: String(r.market_pda), orderId: BigInt(r.order_id as string), owner: String(r.owner), side: r.side as OrderState["side"],
    price: Number(r.price_cents), qtyOriginal: BigInt(r.qty_original as string), qtyFilled: BigInt(r.qty_filled as string),
    tif: String(r.tif), tag: r.tag as OrderState["tag"], intent: r.intent as OrderState["intent"], status: r.status as OrderState["status"],
    cancelReason: (r.cancel_reason as string | null) ?? null, placedSig: String(r.placed_sig), placedAt: unix(r.placed_at),
    updatedAt: unix(r.updated_at),
  };
}

function rowToPosition(r: Record<string, unknown>, pendingNo: bigint): PositionState {
  return {
    ...emptyPosition(String(r.owner), String(r.market_pda)),
    yes: BigInt(r.yes_qty as string), no: BigInt(r.no_qty as string), yesCost: BigInt(r.yes_cost_micro as string),
    noCost: BigInt(r.no_cost_micro as string), realized: BigInt(r.realized_pnl_micro as string),
    ledgerUsdc: BigInt(r.ledger_free_usdc as string), ledgerYes: BigInt(r.ledger_free_yes as string), pendingNo,
    redeemed: Boolean(r.redeemed), lastSeq: BigInt(r.last_seq as string), updatedAt: unix(r.updated_at),
  };
}
