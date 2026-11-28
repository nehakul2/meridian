/**
 * MER-60: reference, status and market read routes (spec 7.1, 7.2). Hot reads are Redis
 * pipelines; calendar, candles, older trades and disputes come from the PG read replica.
 */
import type { FastifyInstance } from "fastify";
import { ApiError } from "../../../shared/src/http.js";
import { K } from "../../../shared/src/keys.js";
import { dayPhase, etDateKey, iso, isoToKey, keyToIso, noView } from "../../../shared/src/market.js";
import type { Ctx } from "../app.js";
import { knownOutcome, marketIdsFor, marketJson, readCfg, readMarkets, readTdays } from "../read.js";

type Q = Record<string, string | undefined>;

export function intParam(v: string | undefined, name: string, def: number, min: number, max: number): number {
  if (v === undefined || v === "") return def;
  if (!/^-?\d+$/.test(v)) throw new ApiError("VALIDATION", `${name} must be an integer`, { field: name });
  const x = Number(v);
  if (x < min || x > max) throw new ApiError("VALIDATION", `${name} must be between ${min} and ${max}`, { field: name });
  return x;
}

function dateParam(v: string | undefined, def: number): number {
  if (v === undefined || v === "") return def;
  const k = isoToKey(v);
  if (k == null) throw new ApiError("VALIDATION", "date must be YYYY-MM-DD", { field: "date" });
  return k;
}

const isoOrNull = (s: number | null | undefined) => (s ? iso(s) : null);

/** Trading days cache (PG trading_calendar), refreshed at most every 5 minutes. */
class CalendarCache {
  private days: Map<string, { open: Date; close: Date; half: boolean }> | null = null;
  private at = 0;
  constructor(private readonly ctx: Ctx) {}
  async isTradingDay(key: number): Promise<boolean> {
    await this.refresh();
    if (!this.days || this.days.size === 0) {
      const d = new Date(`${keyToIso(key)}T12:00:00Z`).getUTCDay();
      return d !== 0 && d !== 6;
    }
    return this.days.has(keyToIso(key));
  }
  private async refresh() {
    if (!this.ctx.pgRead || this.ctx.now() - this.at < 300_000) return;
    this.at = this.ctx.now();
    try {
      const r = await this.ctx.pgRead.query<{ d: string; open_time: Date; close_time: Date; is_half_day: boolean }>(
        "SELECT to_char(trading_date, 'YYYY-MM-DD') AS d, open_time, close_time, is_half_day FROM trading_calendar WHERE trading_date BETWEEN now()::date - 7 AND now()::date + 400",
      );
      this.days = new Map(r.rows.map((x) => [x.d, { open: x.open_time, close: x.close_time, half: x.is_half_day }]));
    } catch {
      /* keep the stale copy; status must not fail on a PG hiccup */
    }
  }
}

export async function marketRoutes(app: FastifyInstance, ctx: Ctx) {
  const cal = new CalendarCache(ctx);
  const prevCloseCache = new Map<string, { at: number; v: Map<string, string> }>();

  app.get("/v1/health", async () => {
    const [slot, last] = await Promise.all([ctx.redis.get(K.slot), ctx.redis.xrevrange("md:events", "+", "-", "COUNT", 1)]);
    let indexerLagMs: number | null = null;
    const e = last[0];
    if (e) {
      const f = e[1];
      const bt = f[f.indexOf("block_time") + 1];
      if (f.includes("block_time") && bt) indexerLagMs = Math.max(0, Number(e[0].split("-")[0]) - Number(bt) * 1000);
    }
    return { ok: true, slot: slot ? Number(slot) : null, indexerLagMs, serverTime: new Date(ctx.now()).toISOString() };
  });

  // GET /v1/status (spec 7.1, HLT-04, PSE-06, CAL-08): serverTime feeds the countdown (R7.3).
  app.get("/v1/status", async () => {
    const now = ctx.nowS();
    const d = etDateKey(now);
    const [cfg, slot, tdays, ids] = await Promise.all([
      readCfg(ctx.redis), ctx.redis.get(K.slot), readTdays(ctx.redis, ctx.tickers, d), ctx.redis.smembers(K.dayMarkets(d)),
    ]);
    const present = tdays.filter((t) => t && t.closeTime) as NonNullable<(typeof tdays)[number]>[];
    // The day's times: the earliest close among the ticker-days (half days close at 13:00 ET).
    const times = present.length > 0
      ? {
          mintOpenTime: Math.min(...present.map((t) => t.mintOpenTime || t.openTime)),
          openTime: Math.min(...present.map((t) => t.openTime)),
          closeTime: Math.min(...present.map((t) => t.closeTime)),
        }
      : null;
    let allSettled = ids.length > 0;
    if (ids.length > 0) {
      const p = ctx.redis.pipeline();
      for (const m of ids) p.hget(K.mkt(m), "status");
      const st = (await p.exec())!.map((x) => x[1] as string | null);
      allSettled = st.every((s) => s === "SETTLED" || s === "VOID");
    }
    const phase = dayPhase(now, times, present.map((t) => t.status), allSettled, await cal.isTradingDay(d));
    return {
      paused: cfg.paused,
      slot: slot ? Number(slot) : null,
      tradingDate: keyToIso(d),
      phase,
      openTime: isoOrNull(times?.openTime),
      closeTime: isoOrNull(times?.closeTime),
      closeTimeUnix: times?.closeTime ?? null,
      serverTime: new Date(ctx.now()).toISOString(),
    };
  });

  app.get("/v1/calendar", async (req) => {
    const q = req.query as Q;
    const today = etDateKey(ctx.nowS());
    const from = dateParam(q.from, today);
    const to = dateParam(q.to, from + 100); // roughly a month of keys; clamped below
    if (to < from) throw new ApiError("VALIDATION", "to must not be before from");
    const r = await ctx.read().query<{ d: string; open_time: Date; close_time: Date; is_half_day: boolean }>(
      "SELECT to_char(trading_date, 'YYYY-MM-DD') AS d, open_time, close_time, is_half_day FROM trading_calendar WHERE trading_date BETWEEN $1::date AND $2::date ORDER BY trading_date LIMIT 400",
      [keyToIso(from), keyToIso(to)],
    );
    return {
      data: r.rows.map((x) => ({
        tradingDate: x.d, openTime: x.open_time.toISOString(), closeTime: x.close_time.toISOString(),
        closeTimeUnix: Math.floor(x.close_time.getTime() / 1000), halfDay: x.is_half_day,
      })),
    };
  });

  // GET /v1/tickers: live underlying (display only) and active contract counts.
  app.get("/v1/tickers", async () => {
    const now = ctx.nowS();
    const d = etDateKey(now);
    const p = ctx.redis.pipeline();
    for (const t of ctx.tickers) {
      p.hgetall(K.px(t));
      p.zrange(K.dayStrikes(d, t), 0, -1);
      p.hget(K.tday(t, d), "status");
    }
    const res = (await p.exec())!;
    const idsOf = ctx.tickers.map((_, i) => res[3 * i + 1]![1] as string[]);
    // One round trip for every ticker's markets (MER-83 found seven sequential reads here).
    const [prev, all] = await Promise.all([prevCloses(d), readMarkets(ctx.redis, idsOf.flat())]);
    const out = [];
    let at = 0;
    for (const [i, t] of ctx.tickers.entries()) {
      const px = res[3 * i]![1] as Record<string, string>;
      const ids = idsOf[i]!;
      const st = res[3 * i + 2]![1] as string | null;
      const rows = all.slice(at, (at += ids.length));
      const active = rows.filter((r) => r && marketJson(r, now).status === "TRADING").length;
      out.push({
        symbol: t,
        underlying: px && px.price ? { price: px.price, conf: px.conf ?? null, publishTime: px.publish_time ? iso(Number(px.publish_time)) : null } : null,
        prevClose: prev.get(t) ?? null,
        activeMarkets: active,
        tickerDayStatus: st || (ids.length > 0 ? "OPEN" : null),
      });
    }
    return { data: out };
  });

  async function prevCloses(d: number): Promise<Map<string, string>> {
    const c = prevCloseCache.get(String(d));
    if (c && ctx.now() - c.at < 60_000) return c.v;
    const v = new Map<string, string>();
    if (ctx.pgRead) {
      try {
        const r = await ctx.pgRead.query<{ symbol: string; c: string }>(
          "SELECT symbol, prev_close_cents::text AS c FROM ticker_days WHERE trading_date = $1::date AND prev_close_cents IS NOT NULL",
          [keyToIso(d)],
        );
        for (const x of r.rows) v.set(x.symbol, (Number(x.c) / 100).toFixed(2));
      } catch {
        /* display only */
      }
    }
    prevCloseCache.set(String(d), { at: ctx.now(), v });
    return v;
  }

  app.get("/v1/tickers/:symbol/markets", async (req) => {
    const { symbol } = req.params as { symbol: string };
    const q = req.query as Q;
    const sym = symbol.toUpperCase();
    if (!ctx.tickers.includes(sym)) throw new ApiError("NOT_FOUND", `Unknown ticker ${symbol}`);
    const now = ctx.nowS();
    const d = dateParam(q.date, etDateKey(now));
    const ids = await marketIdsFor(ctx.redis, sym, d);
    const [rows, [td]] = await Promise.all([readMarkets(ctx.redis, ids), readTdays(ctx.redis, [sym], d)]);
    return {
      symbol: sym,
      tradingDate: keyToIso(d),
      closeTime: isoOrNull(td?.closeTime),
      closeTimeUnix: td?.closeTime || null,
      markets: rows.filter((r) => r).map((r) => marketJson(r!, now)),
    };
  });

  async function oneMarket(id: string) {
    const [r] = await readMarkets(ctx.redis, [id]);
    if (!r) throw new ApiError("NOT_FOUND", `Unknown market ${id}`);
    return r;
  }

  app.get("/v1/markets/:marketId", async (req) => {
    const r = await oneMarket((req.params as { marketId: string }).marketId);
    const now = ctx.nowS();
    const [td] = await readTdays(ctx.redis, [r.symbol], r.date);
    const o = knownOutcome(r, td ?? null);
    return { ...marketJson(r, now), outcome: o.outcome, outcomeProvisional: o.provisional, settlePrice: r.settlePrice };
  });

  // Book snapshot; view=NO is derived from the same Yes levels with the same seq (API-09).
  app.get("/v1/markets/:marketId/book", async (req) => {
    const { marketId } = req.params as { marketId: string };
    const q = req.query as Q;
    const depth = intParam(q.depth, "depth", 20, 1, 20);
    const view = (q.view ?? "YES").toUpperCase();
    if (view !== "YES" && view !== "NO") throw new ApiError("VALIDATION", "view must be YES or NO", { field: "view" });
    const [exists, snap, bbo] = await Promise.all([ctx.redis.exists(K.mkt(marketId)), ctx.redis.get(K.snap(marketId)), ctx.redis.hget(K.bbo(marketId), "ts")]);
    if (!exists) throw new ApiError("NOT_FOUND", `Unknown market ${marketId}`);
    const s = snap ? (JSON.parse(snap) as { seq: string; bids: [number, number][]; asks: [number, number][] }) : { seq: (await ctx.redis.hget(K.mkt(marketId), "seq")) ?? "0", bids: [], asks: [] };
    const levels = view === "NO" ? noView(s.bids, s.asks) : { bids: s.bids, asks: s.asks };
    return {
      marketId, seq: String(s.seq), view,
      bids: levels.bids.slice(0, depth), asks: levels.asks.slice(0, depth),
      updatedAt: bbo ? new Date(Number(bbo)).toISOString() : null,
    };
  });

  // Recent trades: Redis keeps the last 100; older pages come from PG fills.
  app.get("/v1/markets/:marketId/trades", async (req) => {
    const { marketId } = req.params as { marketId: string };
    const q = req.query as Q;
    const limit = intParam(q.limit, "limit", 50, 1, 200);
    const before = q.before === undefined ? null : BigInt(intParam(q.before, "before", 0, 1, Number.MAX_SAFE_INTEGER));
    if (!(await ctx.redis.exists(K.mkt(marketId)))) throw new ApiError("NOT_FOUND", `Unknown market ${marketId}`);
    const raw = await ctx.redis.lrange(K.trades(marketId), 0, -1);
    const all = raw.map((s) => JSON.parse(s) as { seq: string; price: number; qty: number; taker_side: string; ts: number; sig: string });
    const fromRedis = all.filter((t) => before == null || BigInt(t.seq) < before).slice(0, limit);
    const shape = (t: { seq: string; price: number; qty: number; taker_side: string; ts: number; sig: string }) => ({
      seq: String(t.seq), priceCents: t.price, noPriceCents: 100 - t.price, qty: t.qty, takerSide: t.taker_side,
      time: t.ts ? iso(t.ts) : null, signature: t.sig,
    });
    let data = fromRedis.map(shape);
    // The Redis list is a window: page into PG when it cannot fill the request.
    if (data.length < limit && all.length >= 100 && ctx.pgRead) {
      const cursor = data.length > 0 ? BigInt(data.at(-1)!.seq) : before ?? BigInt(all.at(-1)!.seq);
      const r = await ctx.pgRead.query<{ seq: string; price_cents: number; qty: string; taker_side: string; block_time: Date; signature: string }>(
        "SELECT seq::text, price_cents, qty::text, taker_side, block_time, signature FROM fills WHERE market_pda = $1 AND seq < $2 ORDER BY seq DESC LIMIT $3",
        [marketId, cursor.toString(), limit - data.length],
      );
      data = data.concat(r.rows.map((x) => ({
        seq: x.seq, priceCents: x.price_cents, noPriceCents: 100 - x.price_cents, qty: Number(x.qty), takerSide: x.taker_side,
        time: x.block_time.toISOString().replace(/\.000Z$/, "Z"), signature: x.signature,
      })));
    }
    return { marketId, data, nextBefore: data.length === limit ? data.at(-1)!.seq : null };
  });

  const INTERVALS: Record<string, string> = { "1m": "1 minute", "5m": "5 minutes", "15m": "15 minutes", "1h": "1 hour" };
  app.get("/v1/markets/:marketId/candles", async (req) => {
    const { marketId } = req.params as { marketId: string };
    const q = req.query as Q;
    const interval = q.interval ?? "1m";
    if (!INTERVALS[interval]) throw new ApiError("VALIDATION", "interval must be 1m, 5m, 15m or 1h", { field: "interval" });
    const to = q.to ? Date.parse(q.to) : ctx.now();
    const from = q.from ? Date.parse(q.from) : to - 86_400_000;
    if (Number.isNaN(from) || Number.isNaN(to) || to < from) throw new ApiError("VALIDATION", "from/to must be ISO-8601 times with from <= to");
    if (!(await ctx.redis.exists(K.mkt(marketId)))) throw new ApiError("NOT_FOUND", `Unknown market ${marketId}`);
    const r = await ctx.read().query<{ t: Date; o: number; h: number; l: number; c: number; v: string }>(
      `SELECT b AS t, (array_agg(o ORDER BY bucket))[1] AS o, max(h) AS h, min(l) AS l,
              (array_agg(c ORDER BY bucket DESC))[1] AS c, sum(volume)::text AS v
         FROM (SELECT date_bin($4::interval, bucket, '2000-01-01') AS b, * FROM candles_1m
                WHERE market_pda = $1 AND bucket >= $2 AND bucket < $3) x
        GROUP BY b ORDER BY b LIMIT 1500`,
      [marketId, new Date(from), new Date(to), INTERVALS[interval]],
    );
    return { marketId, interval, data: r.rows.map((x) => ({ time: x.t.toISOString(), o: x.o, h: x.h, l: x.l, c: x.c, volume: Number(x.v) })) };
  });

  // GET /v1/settlements (API-08): recorded close and each strike's outcome, provisional until final.
  app.get("/v1/settlements", async (req) => {
    const q = req.query as Q;
    const d = dateParam(q.date, etDateKey(ctx.nowS()));
    const tdays = await readTdays(ctx.redis, ctx.tickers, d);
    const tickers = [];
    for (const [i, sym] of ctx.tickers.entries()) {
      const td = tdays[i];
      const ids = await marketIdsFor(ctx.redis, sym, d);
      if (!td && ids.length === 0) continue;
      const rows = await readMarkets(ctx.redis, ids);
      tickers.push({
        symbol: sym,
        status: td?.status ?? "OPEN",
        closePrice: td?.closePrice ?? null,
        closePriceRaw: td?.closePriceRaw?.toString() ?? null,
        expo: td?.expo ?? null,
        publishTime: isoOrNull(td?.publishTime),
        recordedBy: td?.recordedBy ? (td.override ? "ADMIN" : "SETTLER") : null,
        recordedAt: isoOrNull(td?.recordedAt),
        finalAt: isoOrNull(td?.finalAt) ?? (td?.status === "FINAL" ? null : isoOrNull(td?.finalAtEst)),
        finalAtIsEstimate: td?.status !== "FINAL",
        dispute: td?.dispute ? { ...td.dispute, result: td.disputeResult, originalPriceRaw: td.originalPriceRaw } : null,
        markets: rows.filter((r) => r).map((r) => {
          const o = knownOutcome(r!, td ?? null);
          return { marketId: r!.marketId, strike: (Number(r!.strikeCents) / 100).toFixed(2), strikeCents: Number(r!.strikeCents), outcome: o.outcome, provisional: o.provisional, status: r!.chainStatus };
        }),
      });
    }
    return { tradingDate: keyToIso(d), tickers };
  });

  // GET /v1/disputes (D8): PG history joined with the live ticker-day state.
  app.get("/v1/disputes", async (req) => {
    const q = req.query as Q;
    const d = dateParam(q.date, etDateKey(ctx.nowS()));
    const r = await ctx.read().query<Record<string, unknown>>(
      `SELECT t.symbol, d.ticker_day_pda, d.raised_by, d.bond_micro::text AS bond, d.evidence_hash, d.evidence_url, d.raised_at,
              d.result, d.old_price_raw::text AS old_price_raw, d.new_price_raw::text AS new_price_raw, d.resolved_by, d.resolved_at,
              d.raised_sig, d.resolved_sig, t.status AS ticker_day_status
         FROM disputes d JOIN ticker_days t ON t.pda = d.ticker_day_pda
        WHERE t.trading_date = $1::date ORDER BY t.symbol`,
      [keyToIso(d)],
    );
    return {
      tradingDate: keyToIso(d),
      data: r.rows.map((x) => ({
        symbol: x.symbol, tickerDay: x.ticker_day_pda, raisedBy: x.raised_by, bond: x.bond, evidenceHash: x.evidence_hash,
        evidenceUrl: x.evidence_url ?? null, raisedAt: (x.raised_at as Date).toISOString(),
        status: x.result ? "RESOLVED" : "OPEN", result: x.result ?? null, oldPriceRaw: x.old_price_raw, newPriceRaw: x.new_price_raw ?? null,
        resolvedBy: x.resolved_by ?? null, resolvedAt: x.resolved_at ? (x.resolved_at as Date).toISOString() : null,
        raisedSig: x.raised_sig, resolvedSig: x.resolved_sig ?? null, tickerDayStatus: x.ticker_day_status,
      })),
    };
  });
}
