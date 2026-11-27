/**
 * REST API (component C4, spec 7, MER-60, MER-61, MER-64). Stateless Fastify app:
 * hot reads from Redis, history from the Postgres read replica, and no RPC client at
 * all (API-10). The only tables it writes are `user_prefs` (spec 5) and, for admin
 * routes, `admin_audit` and `alerts.acked_*` (Phase 6 additions, docs/phase6-coverage.md).
 */
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { JwtClaims, verifyJwt } from "../../shared/src/auth.js";
import { ApiError } from "../../shared/src/http.js";
import { K } from "../../shared/src/keys.js";
import type { AdminChainConfig } from "./chain/admin.js";
import { adminRoutes } from "./routes/admin.js";
import { marketRoutes } from "./routes/markets.js";
import { meRoutes } from "./routes/me.js";

/** The slice of `pg.Pool` the API uses, so tests can pass a real pool or a stub. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface ApiDeps {
  redis: Redis;
  /** Read replica for history routes; null disables them (503 UNAVAILABLE). */
  pgRead: Db | null;
  /** Primary, for user_prefs, admin_audit and alert acks. */
  pgWrite: Db | null;
  /** Milliseconds since the epoch. */
  now?: () => number;
  jwtSecret: string;
  jwtTtlS?: number;
  /** Domain the SIWS message names. */
  domain?: string;
  /** Wallets allowed to call admin routes (the multisig's member set). */
  adminSigners: Set<string>;
  adminChain: AdminChainConfig | null;
  /** MAG7 by default. */
  tickers?: string[];
  rateLimit?: { perSecond: number; perMinute: number };
  logger?: boolean;
}

export interface Ctx extends Required<Omit<ApiDeps, "logger" | "pgRead" | "pgWrite" | "adminChain">> {
  pgRead: Db | null;
  pgWrite: Db | null;
  adminChain: AdminChainConfig | null;
  nowS(): number;
  user(req: FastifyRequest): JwtClaims;
  admin(req: FastifyRequest): JwtClaims;
  read(): Db;
  write(): Db;
}

export const MAG7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];

export async function buildApi(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: true, bodyLimit: 64 * 1024 });
  const now = deps.now ?? (() => Date.now());
  const ctx: Ctx = {
    redis: deps.redis,
    pgRead: deps.pgRead,
    pgWrite: deps.pgWrite,
    now,
    nowS: () => Math.floor(now() / 1000),
    jwtSecret: deps.jwtSecret,
    jwtTtlS: deps.jwtTtlS ?? 900,
    domain: deps.domain ?? "meridian.local",
    adminSigners: deps.adminSigners,
    adminChain: deps.adminChain,
    tickers: deps.tickers ?? MAG7,
    rateLimit: deps.rateLimit ?? { perSecond: 20, perMinute: 600 },
    user(req) {
      const h = req.headers.authorization;
      if (!h || !h.startsWith("Bearer ")) throw new ApiError("UNAUTHORIZED", "Sign in first (Authorization: Bearer <token>)");
      const r = verifyJwt(h.slice(7), ctx.jwtSecret, ctx.nowS());
      if (!r.ok) throw new ApiError("UNAUTHORIZED", r.reason === "EXPIRED" ? "Session expired; sign in again" : "Invalid token", { reason: r.reason });
      return r.claims;
    },
    admin(req) {
      const c = ctx.user(req);
      // The claim alone is not enough: the wallet must still be in the signer set.
      if (!c.adm || !ctx.adminSigners.has(c.sub)) throw new ApiError("UNAUTHORIZED", "Admin signer required", {}, 403);
      return c;
    },
    read() {
      if (!ctx.pgRead) throw new ApiError("UNAVAILABLE", "History store not configured");
      return ctx.pgRead;
    },
    write() {
      if (!ctx.pgWrite) throw new ApiError("UNAVAILABLE", "Database not configured");
      return ctx.pgWrite;
    },
  };

  app.setErrorHandler((err: Error & { validation?: unknown; statusCode?: number }, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send(err.body());
    if (err.validation || err.statusCode === 400 || (err as { code?: string }).code === "FST_ERR_CTP_INVALID_JSON_BODY") {
      return reply.status(400).send(new ApiError("VALIDATION", err.message).body());
    }
    if (err.statusCode === 413) return reply.status(413).send(new ApiError("VALIDATION", "Body too large").body());
    app.log.error(err);
    return reply.status(500).send(new ApiError("INTERNAL", "Internal error").body());
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send(new ApiError("NOT_FOUND", "No such route").body()));

  // md:rl:{ip}:{route}:{window}:{start} counters, 1 s and 60 s windows (spec 6.1, API-11).
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const route = req.routeOptions.url ?? "unknown";
    if (route === "/v1/health") return;
    const who = req.ip;
    const t = ctx.nowS();
    const k1 = K.rl(who, route, "1s", t);
    const k60 = K.rl(who, route, "60s", Math.floor(t / 60) * 60);
    const res = await ctx.redis.multi().incr(k1).expire(k1, 2).incr(k60).expire(k60, 61).exec();
    const c1 = Number(res?.[0]?.[1] ?? 0);
    const c60 = Number(res?.[2]?.[1] ?? 0);
    if (c1 > ctx.rateLimit.perSecond || c60 > ctx.rateLimit.perMinute) {
      const retry = c1 > ctx.rateLimit.perSecond ? 1 : 60 - (t % 60);
      reply.header("retry-after", String(retry));
      throw new ApiError("RATE_LIMITED", "Too many requests", { retryAfterS: retry });
    }
  });

  await marketRoutes(app, ctx);
  await meRoutes(app, ctx);
  await adminRoutes(app, ctx);
  return app;
}
