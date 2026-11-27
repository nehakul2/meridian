/**
 * MER-64: admin and ops routes (spec 7.6). Admin JWT only (wallet in the admin signer set,
 * re-checked on every call). Transaction routes return **unsigned** transactions for the
 * Squads multisig and never sign (A22, "ops agents draft only"). Job reruns accept only the
 * idempotent jobs and are handed to Automation through `md:jobreq`. Every call, accepted or
 * refused, is written to `admin_audit` with the caller and payload.
 */
import { PublicKey } from "@solana/web3.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isPubkey } from "../../../shared/src/base58.js";
import { ApiError } from "../../../shared/src/http.js";
import { K } from "../../../shared/src/keys.js";
import { etDateKey, iso, isoToKey, keyToIso } from "../../../shared/src/market.js";
import type { Ctx } from "../app.js";
import {
  ixAddStrike, ixOverrideSettle, ixPause, ixResolveDispute, ixVoidMarket, toUnsigned,
} from "../chain/admin.js";
import { readCfg, readMarkets, readTdays } from "../read.js";

/** Jobs Automation accepts for a manual rerun (services/automation/src/scheduler.ts RERUNNABLE). */
export const RERUNNABLE = ["MORNING", "SETTLE", "FINALIZE", "STRIKE_CRANK", "PRUNE", "CLOSE_BOOK", "RECONCILE"];

type Body = Record<string, unknown>;

export async function adminRoutes(app: FastifyInstance, ctx: Ctx) {
  /** Runs an admin handler and writes the audit row whatever the outcome. */
  function admin(handler: (req: FastifyRequest, caller: string, body: Body) => Promise<unknown>) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body ?? {}) as Body;
      let caller: string | null = null;
      let status = 200;
      let code: string | null = null;
      try {
        caller = ctx.admin(req).sub;
        const out = await handler(req, caller, body);
        status = reply.statusCode;
        return out;
      } catch (e) {
        status = e instanceof ApiError ? e.status : 500;
        code = e instanceof ApiError ? e.code : "INTERNAL";
        throw e;
      } finally {
        await audit(caller ?? callerHint(req), `${req.method} ${req.routeOptions.url}`, { params: req.params, query: req.query, body }, status, code);
      }
    };
  }

  /** The token's subject even when it was refused (for the audit row only). */
  function callerHint(req: FastifyRequest): string {
    try {
      return ctx.user(req).sub;
    } catch {
      return "anonymous";
    }
  }

  async function audit(caller: string, route: string, payload: unknown, status: number, code: string | null) {
    if (!ctx.pgWrite) return;
    await ctx.pgWrite.query(
      "INSERT INTO admin_audit (caller, route, payload, status, error_code) VALUES ($1, $2, $3, $4, $5)",
      [caller, route, JSON.stringify(payload), status, code],
    );
  }

  function chain() {
    if (!ctx.adminChain) throw new ApiError("UNAVAILABLE", "Admin chain config (ADMIN_AUTHORITY, USDC_MINT, FEE_VAULT, BOND_VAULT) not set");
    return ctx.adminChain;
  }

  function symbolDate(b: Body): { symbol: string; date: number } {
    const symbol = typeof b.symbol === "string" ? b.symbol.toUpperCase() : "";
    if (!ctx.tickers.includes(symbol)) throw new ApiError("VALIDATION", "symbol must be one of the configured tickers", { field: "symbol" });
    const date = isoToKey(b.date);
    if (date == null) throw new ApiError("VALIDATION", "date must be YYYY-MM-DD", { field: "date" });
    return { symbol, date };
  }

  function bigintField(b: Body, name: string, min: bigint, max: bigint): bigint {
    const v = b[name];
    if ((typeof v !== "string" && typeof v !== "number") || !/^-?\d+$/.test(String(v))) throw new ApiError("VALIDATION", `${name} must be an integer string`, { field: name });
    const x = BigInt(v);
    if (x < min || x > max) throw new ApiError("VALIDATION", `${name} out of range`, { field: name });
    return x;
  }

  function expoField(b: Body): number {
    if (!Number.isInteger(b.expo) || (b.expo as number) < -12 || (b.expo as number) > 0) throw new ApiError("VALIDATION", "expo must be an integer from -12 to 0", { field: "expo" });
    return b.expo as number;
  }

  // ---- reads ----
  app.get("/v1/admin/jobs", admin(async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const d = q.date ? isoToKey(q.date) : etDateKey(ctx.nowS());
    if (d == null) throw new ApiError("VALIDATION", "date must be YYYY-MM-DD", { field: "date" });
    const r = await ctx.read().query<Record<string, unknown>>(
      `SELECT id::text, job, to_char(trading_date, 'YYYY-MM-DD') AS trading_date, symbol, attempt, status, detail, tx_sigs, started_at, finished_at
         FROM job_runs WHERE trading_date = $1::date ORDER BY started_at DESC LIMIT 500`,
      [keyToIso(d)],
    );
    return {
      data: r.rows.map((x) => ({
        id: x.id, job: x.job, tradingDate: x.trading_date, symbol: x.symbol, attempt: x.attempt, status: x.status, detail: x.detail,
        txSigs: x.tx_sigs ?? [], startedAt: (x.started_at as Date).toISOString(), finishedAt: x.finished_at ? (x.finished_at as Date).toISOString() : null,
      })),
    };
  }));

  app.get("/v1/admin/alerts", admin(async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const open = q.open !== "false";
    const r = await ctx.read().query<Record<string, unknown>>(
      `SELECT id::text, severity, code, symbol, to_char(trading_date, 'YYYY-MM-DD') AS trading_date, message, created_at, acked_by, acked_at
         FROM alerts ${open ? "WHERE acked_at IS NULL" : ""} ORDER BY created_at DESC LIMIT 500`,
    );
    return {
      data: r.rows.map((x) => ({
        id: x.id, severity: x.severity, code: x.code, symbol: x.symbol, tradingDate: x.trading_date, message: x.message,
        createdAt: (x.created_at as Date).toISOString(), ackedBy: x.acked_by, ackedAt: x.acked_at ? (x.acked_at as Date).toISOString() : null,
      })),
    };
  }));

  app.post("/v1/admin/alerts/:id/ack", admin(async (req, caller) => {
    const { id } = req.params as { id: string };
    if (!/^\d+$/.test(id)) throw new ApiError("VALIDATION", "id must be an integer");
    const r = await ctx.write().query<{ id: string; acked_at: Date }>(
      "UPDATE alerts SET acked_by = $2, acked_at = COALESCE(acked_at, now()) WHERE id = $1 RETURNING id::text, acked_at",
      [id, caller],
    );
    if (!r.rows[0]) throw new ApiError("NOT_FOUND", `No alert ${id}`);
    return { id: r.rows[0].id, ackedBy: caller, ackedAt: r.rows[0].acked_at.toISOString() };
  }));

  // Manual rerun (MER-46): idempotent jobs only; anything else needs the multisig path.
  app.post("/v1/admin/jobs/:job/run", admin(async (req, caller, b) => {
    const { job } = req.params as { job: string };
    const name = job.toUpperCase();
    if (!RERUNNABLE.includes(name)) throw new ApiError("NOT_RERUNNABLE", `${name} is not an idempotent job and cannot be rerun from the API`, { job: name, rerunnable: RERUNNABLE });
    const date = isoToKey(b.date);
    if (date == null) throw new ApiError("VALIDATION", "date must be YYYY-MM-DD", { field: "date" });
    const id = await ctx.redis.xadd(K.jobreq, "MAXLEN", "~", "10000", "*", "job", name, "date", keyToIso(date), "requested_by", caller, "requested_at", iso(ctx.nowS()));
    return { requestId: id, job: name, date: keyToIso(date), status: "QUEUED" };
  }));

  // ---- unsigned multisig transactions ----
  app.post("/v1/admin/tx/pause", admin(async () => ({ ...toUnsigned(chain(), [ixPause(chain(), true)]), summary: { action: "PAUSE", copy: "Pause new entries (place, mint). Cancel, merge, withdraw and redeem stay open." } })));
  app.post("/v1/admin/tx/unpause", admin(async () => ({ ...toUnsigned(chain(), [ixPause(chain(), false)]), summary: { action: "UNPAUSE", copy: "Resume new entries." } })));

  app.post("/v1/admin/tx/add-strike", admin(async (_req, _c, b) => {
    const { symbol, date } = symbolDate(b);
    const strike = bigintField(b, "strikeCents", 100n, 10_000_000n);
    if (strike % 50n !== 0n) throw new ApiError("VALIDATION", "strikeCents must be a multiple of 50", { field: "strikeCents" });
    const [td] = await readTdays(ctx.redis, [symbol], date);
    if (!td) throw new ApiError("NOT_FOUND", `No ticker-day ${symbol} ${keyToIso(date)}`);
    if (td.closeTime && ctx.nowS() >= td.closeTime) throw new ApiError("MARKET_HALTED", "Strikes cannot be added after the close");
    const existing = await ctx.redis.zrangebyscore(K.dayStrikes(date, symbol), Number(strike), Number(strike));
    if (existing.length > 0) throw new ApiError("VALIDATION", "Strike already exists", { marketId: existing[0] });
    return { ...toUnsigned(chain(), [ixAddStrike(chain(), symbol, date, strike)]), summary: { action: "ADD_STRIKE", symbol, date: keyToIso(date), strikeCents: Number(strike) } };
  }));

  app.post("/v1/admin/tx/void-market", admin(async (_req, _c, b) => {
    if (typeof b.marketId !== "string" || !isPubkey(b.marketId)) throw new ApiError("VALIDATION", "marketId must be a market address", { field: "marketId" });
    const [m] = await readMarkets(ctx.redis, [b.marketId]);
    if (!m) throw new ApiError("NOT_FOUND", `Unknown market ${b.marketId}`);
    if (m.chainStatus === "SETTLED" || m.chainStatus === "VOID") throw new ApiError("VALIDATION", `Market is already ${m.chainStatus}`);
    const ix = ixVoidMarket(chain(), { address: new PublicKey(m.marketId), vault: new PublicKey(m.vault), yesMint: new PublicKey(m.yesMint), noMint: new PublicKey(m.noMint) });
    return { ...toUnsigned(chain(), [ix]), summary: { action: "VOID_MARKET", marketId: m.marketId } };
  }));

  // ADM-06: refused before close + override_delay, and once the ticker-day is recorded.
  app.post("/v1/admin/tx/override-settle", admin(async (_req, _c, b) => {
    const { symbol, date } = symbolDate(b);
    const price = bigintField(b, "priceRaw", 1n, 9_223_372_036_854_775_807n);
    const expo = expoField(b);
    if (typeof b.reason !== "string" || b.reason.trim().length < 3) throw new ApiError("VALIDATION", "reason is required", { field: "reason" });
    const [[td], cfg] = await Promise.all([readTdays(ctx.redis, [symbol], date), readCfg(ctx.redis)]);
    if (!td || !td.closeTime) throw new ApiError("NOT_FOUND", `No ticker-day ${symbol} ${keyToIso(date)}`);
    if (td.status !== "OPEN") throw new ApiError("ALREADY_RECORDED", `${symbol} ${keyToIso(date)} is already ${td.status}; use the dispute path`, { status: td.status });
    const unlock = td.closeTime + cfg.overrideDelayS;
    if (ctx.nowS() < unlock) {
      throw new ApiError("OVERRIDE_TOO_EARLY", `Override opens at ${iso(unlock)} (close + ${cfg.overrideDelayS / 60} min)`, { earliest: iso(unlock), earliestUnix: unlock });
    }
    return {
      ...toUnsigned(chain(), [ixOverrideSettle(chain(), symbol, date, price, expo)]),
      summary: { action: "OVERRIDE_SETTLE", symbol, date: keyToIso(date), priceRaw: price.toString(), expo, reason: b.reason },
    };
  }));

  app.post("/v1/admin/tx/resolve-dispute", admin(async (_req, _c, b) => {
    const { symbol, date } = symbolDate(b);
    if (b.result !== "UPHELD" && b.result !== "CORRECTED") throw new ApiError("VALIDATION", "result must be UPHELD or CORRECTED", { field: "result" });
    const [td] = await readTdays(ctx.redis, [symbol], date);
    if (!td) throw new ApiError("NOT_FOUND", `No ticker-day ${symbol} ${keyToIso(date)}`);
    if (td.status !== "DISPUTED" || !td.dispute) throw new ApiError("VALIDATION", `${symbol} ${keyToIso(date)} has no open dispute`, { status: td.status });
    const by = String(td.dispute.by ?? "");
    if (!isPubkey(by)) throw new ApiError("UNAVAILABLE", "Dispute record has no disputer");
    const r = b.result === "UPHELD"
      ? { result: "UPHELD" as const }
      : { result: "CORRECTED" as const, priceRaw: bigintField(b, "priceRaw", 1n, 9_223_372_036_854_775_807n), expo: expoField(b) };
    if (r.result === "CORRECTED" && (typeof b.evidence !== "string" || b.evidence.length === 0)) throw new ApiError("VALIDATION", "evidence is required for a correction", { field: "evidence" });
    return {
      ...toUnsigned(chain(), [ixResolveDispute(chain(), symbol, date, new PublicKey(by), r)]),
      summary: {
        action: "RESOLVE_DISPUTE", symbol, date: keyToIso(date), result: r.result, disputer: by,
        ...(r.result === "CORRECTED" ? { priceRaw: r.priceRaw.toString(), expo: r.expo } : {}),
      },
    };
  }));
}
