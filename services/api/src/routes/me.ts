/**
 * MER-61: SIWS sign-in and the portfolio routes (spec 7.3). `owner` is always the JWT
 * subject; an `owner` query or body field is ignored (API-06). Positions and open orders
 * come from Redis (`md:pos`, `md:oo`, confirmed); settled positions that aged out of
 * Redis, order history and the execution log come from PG.
 */
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { signJwt, siwsMessage, verifyEd25519 } from "../../../shared/src/auth.js";
import { isPubkey } from "../../../shared/src/base58.js";
import { ApiError } from "../../../shared/src/http.js";
import { K, TTL } from "../../../shared/src/keys.js";
import { centsToDollars, iso } from "../../../shared/src/market.js";
import type { Ctx } from "../app.js";
import { MarketRow, readMarkets, viewStatus } from "../read.js";
import { intParam } from "./markets.js";

type Q = Record<string, string | undefined>;

interface Pos {
  yes: bigint;
  no: bigint;
  yesCost: bigint;
  noCost: bigint;
  realized: bigint;
  ledgerUsdc: bigint;
  ledgerYes: bigint;
  pendingNo: bigint;
  redeemed: boolean;
}

function posFromRedis(s: string): Pos {
  const j = JSON.parse(s) as Record<string, string | number | boolean>;
  return {
    yes: BigInt(j.yes as number), no: BigInt(j.no as number), yesCost: BigInt((j.yes_cost as string) ?? "0"),
    noCost: BigInt((j.no_cost as string) ?? "0"), realized: BigInt((j.realized as string) ?? "0"),
    ledgerUsdc: BigInt((j.ledger_usdc as string) ?? "0"), ledgerYes: BigInt((j.ledger_yes as number) ?? 0),
    pendingNo: BigInt((j.pending_no as number) ?? 0), redeemed: !!j.redeemed,
  };
}

/** What a settled (or void) position pays on redeem, in micro-USDC. */
export function redeemableMicro(p: Pos, m: MarketRow): bigint {
  if (p.redeemed) return 0n;
  if (m.chainStatus === "SETTLED") return (m.outcome === "YES" ? p.yes : m.outcome === "NO" ? p.no : 0n) * 1_000_000n;
  if (m.chainStatus === "VOID") return (p.yes + p.no) * 500_000n; // D21: zero-trade void pays $0.50 a token
  return 0n;
}

export async function meRoutes(app: FastifyInstance, ctx: Ctx) {
  // ---- SIWS ----
  app.post("/v1/auth/siws/nonce", async (req) => {
    const b = (req.body ?? {}) as { owner?: unknown };
    if (!isPubkey(b.owner)) throw new ApiError("VALIDATION", "owner must be a base58 pubkey", { field: "owner" });
    const nonce = randomBytes(16).toString("hex");
    const now = ctx.nowS();
    const message = siwsMessage({ domain: ctx.domain, owner: b.owner, nonce, issuedAt: iso(now), expirationTime: iso(now + TTL.siws) });
    await ctx.redis.set(K.siws(nonce), JSON.stringify({ owner: b.owner, message }), "EX", TTL.siws);
    return { nonce, message, expiresAt: iso(now + TTL.siws) };
  });

  app.post("/v1/auth/siws/verify", async (req) => {
    const b = (req.body ?? {}) as { owner?: unknown; signature?: unknown; message?: unknown };
    if (!isPubkey(b.owner) || typeof b.signature !== "string" || typeof b.message !== "string") {
      throw new ApiError("VALIDATION", "owner, signature and message are required");
    }
    const m = /\nNonce: ([0-9a-f]{32})\n/.exec(b.message);
    if (!m) throw new ApiError("UNAUTHORIZED", "Message has no nonce");
    // Single use (API-07): GETDEL consumes the nonce whether or not the signature checks out.
    const stored = await ctx.redis.getdel(K.siws(m[1]!));
    if (!stored) throw new ApiError("UNAUTHORIZED", "Nonce unknown, used or expired");
    const s = JSON.parse(stored) as { owner: string; message: string };
    if (s.owner !== b.owner || s.message !== b.message) throw new ApiError("UNAUTHORIZED", "Message does not match the issued nonce");
    if (!verifyEd25519(b.owner, b.message, b.signature)) throw new ApiError("UNAUTHORIZED", "Bad signature");
    const now = ctx.nowS();
    const exp = now + ctx.jwtTtlS;
    const adm = ctx.adminSigners.has(b.owner);
    const token = signJwt({ sub: b.owner, iat: now, exp, ...(adm ? { adm: true } : {}) }, ctx.jwtSecret);
    return { token, expiresAt: iso(exp), admin: adm };
  });

  // ---- positions ----
  async function loadPositions(owner: string, withPg: boolean): Promise<Map<string, Pos>> {
    const h = await ctx.redis.hgetall(K.pos(owner));
    const out = new Map<string, Pos>(Object.entries(h).map(([m, s]) => [m, posFromRedis(s)]));
    // md:pos has a 1 d TTL after the last change: older positions are read from PG.
    if (withPg && ctx.pgRead) {
      const r = await ctx.pgRead.query<Record<string, string | boolean>>(
        `SELECT market_pda, yes_qty::text, no_qty::text, yes_cost_micro::text, no_cost_micro::text, realized_pnl_micro::text,
                ledger_free_usdc::text, ledger_free_yes::text, redeemed FROM positions WHERE owner = $1`,
        [owner],
      );
      for (const x of r.rows) {
        if (out.has(x.market_pda as string)) continue;
        out.set(x.market_pda as string, {
          yes: BigInt(x.yes_qty as string), no: BigInt(x.no_qty as string), yesCost: BigInt(x.yes_cost_micro as string),
          noCost: BigInt(x.no_cost_micro as string), realized: BigInt(x.realized_pnl_micro as string),
          ledgerUsdc: BigInt(x.ledger_free_usdc as string), ledgerYes: BigInt(x.ledger_free_yes as string), pendingNo: 0n,
          redeemed: !!x.redeemed,
        });
      }
    }
    return out;
  }

  app.get("/v1/me/positions", async (req) => {
    const owner = ctx.user(req).sub;
    const q = req.query as Q;
    const status = (q.status ?? "OPEN").toUpperCase();
    if (!["OPEN", "SETTLED", "ALL"].includes(status)) throw new ApiError("VALIDATION", "status must be OPEN, SETTLED or ALL", { field: "status" });
    const pos = await loadPositions(owner, status !== "OPEN");
    const ids = [...pos.keys()];
    const rows = await readMarkets(ctx.redis, ids);
    const now = ctx.nowS();
    const data = [];
    for (const [i, m] of ids.entries()) {
      const r = rows[i];
      const p = pos.get(m)!;
      if (!r) continue;
      const settled = r.chainStatus === "SETTLED" || r.chainStatus === "VOID";
      if (status === "OPEN" && settled) continue;
      if (status === "SETTLED" && !settled) continue;
      if (p.yes === 0n && p.no === 0n && p.ledgerUsdc === 0n && p.realized === 0n) continue;
      // A10: a resting Buy No limit holds both legs; show it as one pending Buy No.
      const side = p.pendingNo > 0n ? "BOTH_PENDING" : p.yes > 0n && p.no > 0n ? "BOTH" : p.no > 0n ? "NO" : p.yes > 0n ? "YES" : "FLAT";
      const isNo = side === "NO" || side === "BOTH_PENDING";
      const qty = isNo ? p.no : p.yes;
      const cost = isNo ? p.noCost : side === "BOTH" ? p.yesCost + p.noCost : p.yesCost;
      const bid = r.bbo.bid ? Number(r.bbo.bid) : null;
      const ask = r.bbo.ask ? Number(r.bbo.ask) : null;
      const yesMark = bid != null && ask != null ? (bid + ask) / 2 : r.lastCents;
      let markCents: number | null = yesMark == null ? null : isNo ? 100 - yesMark : yesMark;
      if (r.chainStatus === "SETTLED") markCents = (r.outcome === "YES") !== isNo ? 100 : 0;
      if (r.chainStatus === "VOID") markCents = 50;
      // Unrealized P&L against the mark (A29); BOTH (direct mint) is worth $1.00 a pair.
      const value = side === "BOTH"
        ? p.yes * BigInt(Math.round((markCents ?? 50) * 10_000)) + p.no * BigInt(Math.round((100 - (markCents ?? 50)) * 10_000))
        : markCents == null ? null : (qty * BigInt(Math.round(markCents * 100)) * 10_000n) / 100n;
      const unrealized = p.redeemed || value == null ? 0n : value - cost;
      data.push({
        marketId: m, symbol: r.symbol, strike: centsToDollars(r.strikeCents), side, qty: Number(qty),
        yesQty: Number(p.yes), noQty: Number(p.no),
        avgEntryCents: qty > 0n ? Math.round((Number(cost) / Number(qty) / 10_000) * 100) / 100 : null,
        markCents, unrealizedPnl: unrealized.toString(), realizedPnl: p.realized.toString(),
        status: viewStatus(r, now), outcome: r.outcome, payoutIfWin: (qty * 1_000_000n).toString(),
        redeemable: redeemableMicro(p, r).toString(), redeemed: p.redeemed,
        ledger: { freeUsdc: p.ledgerUsdc.toString(), freeYes: Number(p.ledgerYes) },
      });
    }
    return { data };
  });

  // ---- orders ----
  app.get("/v1/me/orders", async (req) => {
    const owner = ctx.user(req).sub;
    const q = req.query as Q;
    const status = (q.status ?? "OPEN").toUpperCase();
    if (status !== "OPEN" && status !== "ALL") throw new ApiError("VALIDATION", "status must be OPEN or ALL", { field: "status" });
    const limit = intParam(q.limit, "limit", 100, 1, 500);
    const shape = (o: { market: string; order_id: string; side: string; price: number; qty_original: number; qty_filled: number; tif: string; intent: string; status: string; placed_at?: number | string; placed_sig?: string }) => {
      const noTerms = o.intent === "BUY_NO" || o.intent === "SELL_NO";
      return {
        marketId: o.market, orderId: String(o.order_id), intent: o.intent, bookSide: o.side, yesPriceCents: o.price,
        priceCents: noTerms ? 100 - o.price : o.price, qty: o.qty_original, filled: o.qty_filled, remaining: o.qty_original - o.qty_filled,
        tif: o.tif, status: o.status, placedAt: typeof o.placed_at === "number" ? (o.placed_at ? iso(o.placed_at) : null) : o.placed_at ?? null,
        signature: o.placed_sig ?? null,
      };
    };
    if (status === "OPEN") {
      const h = await ctx.redis.hgetall(K.oo(owner));
      let list = Object.values(h).map((s) => JSON.parse(s));
      if (q.marketId) list = list.filter((o) => o.market === q.marketId);
      return { data: list.map(shape).slice(0, limit) };
    }
    const params: unknown[] = [owner, limit];
    let where = "owner = $1";
    if (q.marketId) {
      params.push(q.marketId);
      where += " AND market_pda = $3";
    }
    const r = await ctx.read().query<Record<string, unknown>>(
      `SELECT market_pda AS market, order_id::text, side, price_cents AS price, qty_original::int, qty_filled::int, tif, intent, status,
              placed_at, placed_sig FROM orders WHERE ${where} ORDER BY placed_at DESC LIMIT $2`,
      params,
    );
    return { data: r.rows.map((x) => shape({ ...(x as object), placed_at: (x.placed_at as Date).toISOString() } as Parameters<typeof shape>[0])) };
  });

  // ---- execution log by intent (IDX-02): fills, plus direct mint/merge and redeem ----
  app.get("/v1/me/history", async (req) => {
    const owner = ctx.user(req).sub;
    const q = req.query as Q;
    const limit = intParam(q.limit, "limit", 50, 1, 200);
    const before = q.before ? new Date(q.before) : new Date(8.64e15);
    if (Number.isNaN(before.getTime())) throw new ApiError("VALIDATION", "before must be an ISO-8601 time", { field: "before" });
    const r = await ctx.read().query<{ t: Date; market: string; intent: string; qty: string; price: number | null; fee: string; sig: string; usdc: string | null }>(
      `SELECT * FROM (
         SELECT block_time AS t, market_pda AS market, CASE WHEN taker = $1 THEN taker_intent ELSE maker_intent END AS intent,
                qty::text AS qty, price_cents AS price, CASE WHEN taker = $1 THEN taker_fee_micro ELSE 0 END::text AS fee,
                signature AS sig, NULL::text AS usdc, event_index AS ev
           FROM fills WHERE (taker = $1 OR maker = $1) AND block_time < $2
         UNION ALL
         SELECT block_time, market_pda, kind, GREATEST(yes_qty, no_qty)::text, NULL, '0', signature, usdc_micro::text, event_index
           FROM mint_merge_redeem WHERE owner = $1 AND block_time < $2 AND (kind = 'REDEEM' OR via = 'DIRECT')
       ) h ORDER BY t DESC, sig, ev LIMIT $3`,
      [owner, before, limit],
    );
    const data = r.rows.map((x) => {
      const noTerms = x.intent === "BUY_NO" || x.intent === "SELL_NO";
      return {
        time: x.t.toISOString().replace(/\.000Z$/, "Z"), marketId: x.market, intent: x.intent, qty: Number(x.qty),
        priceCents: x.price == null ? null : noTerms ? 100 - x.price : x.price, fee: x.fee, usdc: x.usdc, signature: x.sig,
      };
    });
    return { data, nextBefore: data.length === limit ? data.at(-1)!.time : null };
  });

  // ---- claimable (RED-10): unwithdrawn ledger proceeds and redeemable winnings ----
  app.get("/v1/me/claimable", async (req) => {
    const owner = ctx.user(req).sub;
    const pos = await loadPositions(owner, true);
    const ids = [...pos.keys()];
    const rows = await readMarkets(ctx.redis, ids);
    let ledgerTotal = 0n;
    let redeemTotal = 0n;
    const data = [];
    for (const [i, m] of ids.entries()) {
      const r = rows[i];
      const p = pos.get(m)!;
      const redeemable = r ? redeemableMicro(p, r) : 0n;
      if (p.ledgerUsdc === 0n && p.ledgerYes === 0n && redeemable === 0n) continue;
      ledgerTotal += p.ledgerUsdc;
      redeemTotal += redeemable;
      data.push({
        marketId: m, symbol: r?.symbol ?? null, strike: r ? centsToDollars(r.strikeCents) : null, status: r?.chainStatus ?? null,
        ledger: { freeUsdc: p.ledgerUsdc.toString(), freeYes: Number(p.ledgerYes) }, redeemable: redeemable.toString(),
      });
    }
    return { data, totals: { ledgerUsdc: ledgerTotal.toString(), redeemable: redeemTotal.toString() } };
  });

  // ---- prefs: user_prefs is the only table this route family writes ----
  app.get("/v1/me/prefs", async (req) => {
    const owner = ctx.user(req).sub;
    const r = await ctx.read().query<{ default_view: string; slippage_cents: number }>("SELECT default_view, slippage_cents FROM user_prefs WHERE owner = $1", [owner]);
    const x = r.rows[0];
    return { defaultView: x?.default_view ?? "YES", slippageCents: x?.slippage_cents ?? 2 };
  });

  app.put("/v1/me/prefs", async (req) => {
    const owner = ctx.user(req).sub;
    const b = (req.body ?? {}) as { defaultView?: unknown; slippageCents?: unknown };
    if (typeof b !== "object" || Array.isArray(b)) throw new ApiError("VALIDATION", "body must be an object");
    const extra = Object.keys(b).filter((k) => k !== "defaultView" && k !== "slippageCents");
    if (extra.length > 0) throw new ApiError("VALIDATION", `unknown field ${extra[0]}`, { field: extra[0] });
    if (b.defaultView !== undefined && b.defaultView !== "YES" && b.defaultView !== "NO") throw new ApiError("VALIDATION", "defaultView must be YES or NO", { field: "defaultView" });
    if (b.slippageCents !== undefined && (!Number.isInteger(b.slippageCents) || (b.slippageCents as number) < 0 || (b.slippageCents as number) > 20)) {
      throw new ApiError("VALIDATION", "slippageCents must be an integer from 0 to 20", { field: "slippageCents" });
    }
    const r = await ctx.write().query<{ default_view: string; slippage_cents: number }>(
      `INSERT INTO user_prefs (owner, default_view, slippage_cents, updated_at) VALUES ($1, COALESCE($2, 'YES'), COALESCE($3, 2), now())
       ON CONFLICT (owner) DO UPDATE SET default_view = COALESCE($2, user_prefs.default_view),
         slippage_cents = COALESCE($3, user_prefs.slippage_cents), updated_at = now()
       RETURNING default_view, slippage_cents`,
      [owner, b.defaultView ?? null, b.slippageCents ?? null],
    );
    return { defaultView: r.rows[0]!.default_view, slippageCents: r.rows[0]!.slippage_cents };
  });
}
