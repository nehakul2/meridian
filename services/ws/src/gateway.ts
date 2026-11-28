/**
 * WS Gateway (component C5, spec 6.2, 6.4, 7.5, MER-65). Stateless apart from connection
 * state in memory: it reads Redis only (snapshots with GET, everything else from pub/sub)
 * and never touches Postgres.
 *
 * Channels (client name → Redis channel):
 *   book:{m}   → md:ch:book:{m}    snapshot first, then deltas whose `prev_seq` chains
 *   trades:{m} → md:ch:trades:{m}
 *   market:{m} → md:ch:market:{m}
 *   px:{t}     → md:ch:px:{t}      at most 4 a second per connection (WS-06)
 *   user       → md:ch:user:{o}    after `auth`; o = the JWT subject only (WS-03)
 *   sys        → md:ch:sys
 *
 * Book ordering (WS-01, WS-02): the Indexer stamps each `book_delta` with `seq` and the
 * `prev_seq` of the snapshot it applies to. The gateway forwards a delta only when its
 * `prev_seq` equals the last seq this client was sent, drops one with `seq` at or below it,
 * and answers a gap (a delta Redis pub/sub lost) with a fresh snapshot. So the seqs a
 * client sees always chain.
 */
import { createServer, IncomingMessage, Server } from "node:http";
import type { Redis } from "ioredis";
import { WebSocket, WebSocketServer } from "ws";
import { verifyJwt } from "../../shared/src/auth.js";
import { K } from "../../shared/src/keys.js";

export interface GatewayOptions {
  /** Command connection (snapshots, balances). */
  redis: Redis;
  /** A dedicated connection for SUBSCRIBE. */
  sub: Redis;
  jwtSecret: string;
  now?: () => number;
  heartbeatMs?: number;
  /** A client whose unsent buffer passes this many bytes is dropped, not buffered forever. */
  maxBufferedBytes?: number;
  pxIntervalMs?: number;
  maxSubscriptions?: number;
  log?: { info(msg: string, o?: object): void; warn(msg: string, o?: object): void };
}

interface Conn {
  ws: WebSocket;
  owner: string | null;
  subs: Set<string>;
  /** book:{m} → last seq sent; absent while the snapshot is being fetched. */
  bookSeq: Map<string, bigint>;
  /** Deltas that arrived while the snapshot was in flight. */
  pending: Map<string, Record<string, unknown>[]>;
  px: Map<string, { last: number; timer: NodeJS.Timeout | null; queued: string | null }>;
}

const CHANNEL = /^(book|trades|market):([1-9A-HJ-NP-Za-km-z]{32,44})$|^px:([A-Z]{1,8})$|^(user|sys)$/;

export class Gateway {
  readonly server: Server;
  readonly wss: WebSocketServer;
  private readonly conns = new Set<Conn>();
  /** Redis channel → connections subscribed to it. */
  private readonly routes = new Map<string, Set<Conn>>();
  private readonly subscribing = new Map<string, Promise<unknown>>();
  private heartbeat: NodeJS.Timeout | null = null;
  /** Counters served on GET /healthz for the Monitor (MER-81): `errors` counts failed client ops and socket errors. */
  readonly stats = { dropped: 0, forwarded: 0, snapshots: 0, errors: 0, subReconnects: 0 };
  private readonly startedAt = Date.now();
  private readonly o: Required<Omit<GatewayOptions, "log">> & Pick<GatewayOptions, "log">;

  constructor(o: GatewayOptions) {
    this.o = {
      now: () => Date.now(), heartbeatMs: 15_000, maxBufferedBytes: 1 << 20, pxIntervalMs: 250, maxSubscriptions: 200, ...o,
    };
    this.server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: this.o.sub.status === "ready", connections: this.conns.size, ...this.stats, startedAt: this.startedAt }));
        return;
      }
      res.writeHead(426, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "VALIDATION", message: "WebSocket upgrade required", details: {} } }));
    });
    this.wss = new WebSocketServer({ server: this.server, path: "/v1/ws", maxPayload: 16 * 1024 });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
    this.o.sub.on("message", (ch: string, msg: string) => this.onRedis(ch, msg));
    // After the subscriber connection drops and reconnects, subscribe again to every channel
    // with listeners. ioredis's own resubscribe was seen not to happen on CI (the server listed
    // the reconnected client with no subscriptions while it reported "ready"), and a gateway
    // that silently stops forwarding is the worst failure it can have. SUBSCRIBE is idempotent.
    let first = true;
    this.o.sub.on("ready", () => {
      if (first) {
        first = false;
        if (this.routes.size === 0) return;
      } else this.stats.subReconnects++;
      const chans = [...this.routes.keys()];
      if (chans.length > 0) void this.o.sub.subscribe(...chans).catch((e) => this.o.log?.warn("resubscribe failed", { e: String(e) }));
    });
  }

  async listen(port: number, host = "0.0.0.0"): Promise<number> {
    await new Promise<void>((res) => this.server.listen(port, host, res));
    this.heartbeat = setInterval(() => {
      const serverTime = new Date(this.o.now()).toISOString();
      for (const c of this.conns) this.send(c, { type: "heartbeat", serverTime });
    }, this.o.heartbeatMs);
    const a = this.server.address();
    return typeof a === "object" && a ? a.port : port;
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.conns) c.ws.terminate();
    await new Promise<void>((res) => this.wss.close(() => res()));
    await new Promise<void>((res) => this.server.close(() => res()));
  }

  get connections(): number {
    return this.conns.size;
  }

  private onConnection(ws: WebSocket, _req: IncomingMessage) {
    const c: Conn = { ws, owner: null, subs: new Set(), bookSeq: new Map(), pending: new Map(), px: new Map() };
    this.conns.add(c);
    ws.on("message", (raw) => void this.onClient(c, raw.toString()).catch((e) => {
      this.stats.errors++;
      this.o.log?.warn("ws op failed", { e: String(e) });
    }));
    ws.on("close", () => this.drop(c));
    ws.on("error", () => {
      this.stats.errors++;
      this.drop(c);
    });
  }

  private drop(c: Conn) {
    if (!this.conns.delete(c)) return;
    for (const s of c.subs) this.unroute(c, this.redisChannel(c, s));
    for (const p of c.px.values()) if (p.timer) clearTimeout(p.timer);
  }

  /** Sends one message; a client that cannot keep up is disconnected (slow consumer). */
  private send(c: Conn, msg: object | string): boolean {
    if (c.ws.readyState !== WebSocket.OPEN) return false;
    if (c.ws.bufferedAmount > this.o.maxBufferedBytes) {
      this.stats.dropped++;
      this.o.log?.warn("slow consumer dropped", { buffered: c.ws.bufferedAmount });
      c.ws.terminate();
      this.drop(c);
      return false;
    }
    c.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
    return true;
  }

  private error(c: Conn, code: string, message: string, extra: object = {}) {
    this.send(c, { type: "error", code, message, ...extra });
  }

  private redisChannel(c: Conn, name: string): string {
    if (name === "user") return K.ch.user(c.owner ?? "");
    if (name === "sys") return K.ch.sys;
    const [kind, id] = name.split(":") as [string, string];
    if (kind === "book") return K.ch.book(id);
    if (kind === "trades") return K.ch.trades(id);
    if (kind === "market") return K.ch.market(id);
    return K.ch.px(id);
  }

  private async route(c: Conn, ch: string) {
    let set = this.routes.get(ch);
    if (!set) {
      set = new Set();
      this.routes.set(ch, set);
    }
    set.add(c);
    if (!this.subscribing.has(ch)) this.subscribing.set(ch, this.o.sub.subscribe(ch));
    await this.subscribing.get(ch); // subscribed before any snapshot is read, so no delta falls in between
  }

  private unroute(c: Conn, ch: string) {
    const set = this.routes.get(ch);
    if (!set) return;
    set.delete(c);
    if (set.size === 0) {
      this.routes.delete(ch);
      this.subscribing.delete(ch);
      void this.o.sub.unsubscribe(ch).catch(() => undefined);
    }
  }

  private async onClient(c: Conn, raw: string) {
    let m: { op?: unknown; channels?: unknown; channel?: unknown; token?: unknown };
    try {
      m = JSON.parse(raw);
    } catch {
      return this.error(c, "VALIDATION", "messages must be JSON");
    }
    switch (m.op) {
      case "ping":
        return this.send(c, { type: "pong", serverTime: new Date(this.o.now()).toISOString() });
      case "auth": {
        const r = typeof m.token === "string" ? verifyJwt(m.token, this.o.jwtSecret, Math.floor(this.o.now() / 1000)) : null;
        if (!r || !r.ok) return this.error(c, "UNAUTHORIZED", "invalid or expired token");
        if (c.owner && c.owner !== r.claims.sub && c.subs.has("user")) {
          this.unroute(c, K.ch.user(c.owner));
          c.subs.delete("user");
        }
        c.owner = r.claims.sub;
        this.send(c, { type: "auth_ok", owner: c.owner });
        const bal = await this.o.redis.get(K.bal(c.owner));
        if (bal !== null) this.send(c, { type: "balance", channel: "user", usdc: bal });
        return;
      }
      case "subscribe":
      case "unsubscribe": {
        if (!Array.isArray(m.channels) || m.channels.length === 0 || m.channels.length > 50) return this.error(c, "VALIDATION", "channels must be a list of 1 to 50 names");
        for (const ch of m.channels) {
          if (typeof ch !== "string" || !CHANNEL.test(ch)) {
            this.error(c, "VALIDATION", `unknown channel ${String(ch).slice(0, 64)}`, { channel: String(ch).slice(0, 64) });
            continue;
          }
          if (m.op === "unsubscribe") {
            if (c.subs.delete(ch)) this.unroute(c, this.redisChannel(c, ch));
            c.bookSeq.delete(ch);
            c.pending.delete(ch);
            continue;
          }
          if (ch === "user" && !c.owner) {
            this.error(c, "UNAUTHORIZED", "send auth before subscribing to user", { channel: "user" });
            continue;
          }
          if (c.subs.has(ch)) continue;
          if (c.subs.size >= this.o.maxSubscriptions) {
            this.error(c, "VALIDATION", "too many subscriptions");
            break;
          }
          c.subs.add(ch);
          if (ch.startsWith("book:")) c.pending.set(ch, []);
          await this.route(c, this.redisChannel(c, ch));
          this.send(c, { type: "subscribed", channel: ch });
          if (ch.startsWith("book:")) await this.snapshot(c, ch);
        }
        return;
      }
      case "snapshot": {
        // A client that saw a seq gap asks for a fresh snapshot (spec 7.5).
        if (typeof m.channel !== "string" || !m.channel.startsWith("book:") || !c.subs.has(m.channel)) return this.error(c, "VALIDATION", "snapshot needs a subscribed book channel");
        return this.snapshot(c, m.channel);
      }
      default:
        return this.error(c, "VALIDATION", "op must be subscribe, unsubscribe, auth, snapshot or ping");
    }
  }

  /** Sends `book_snapshot` from `md:book:{m}:snap`, then any deltas that arrived meanwhile. */
  private async snapshot(c: Conn, ch: string) {
    const m = ch.slice(5);
    c.bookSeq.delete(ch);
    if (!c.pending.has(ch)) c.pending.set(ch, []);
    const s = await this.o.redis.get(K.snap(m));
    const snap = s ? (JSON.parse(s) as { seq: string; bids: unknown[]; asks: unknown[] }) : { seq: (await this.o.redis.hget(K.mkt(m), "seq")) ?? "0", bids: [], asks: [] };
    this.stats.snapshots++;
    this.send(c, { type: "book_snapshot", channel: ch, seq: String(snap.seq), bids: snap.bids, asks: snap.asks });
    c.bookSeq.set(ch, BigInt(snap.seq));
    const queued = c.pending.get(ch) ?? [];
    c.pending.delete(ch);
    for (const d of queued) await this.bookMessage(c, ch, d);
  }

  private async bookMessage(c: Conn, ch: string, d: Record<string, unknown>) {
    if (!c.bookSeq.has(ch)) {
      c.pending.get(ch)?.push(d);
      return;
    }
    const last = c.bookSeq.get(ch)!;
    const seq = BigInt(String(d.seq ?? "0"));
    if (d.type === "book_snapshot") {
      // A correction from the Indexer (IDX-05) replaces the client's book.
      this.send(c, { ...d, channel: ch });
      c.bookSeq.set(ch, seq);
      return;
    }
    if (seq <= last) return; // already covered by the snapshot this client has
    if (d.prev_seq !== undefined && BigInt(String(d.prev_seq)) !== last) {
      await this.snapshot(c, ch); // a delta went missing between Redis and us: resync
      return;
    }
    this.stats.forwarded++;
    this.send(c, { ...d, channel: ch });
    c.bookSeq.set(ch, seq);
  }

  private onRedis(redisCh: string, raw: string) {
    const set = this.routes.get(redisCh);
    if (!set || set.size === 0) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const kind = redisCh.split(":")[2]!;
    const id = redisCh.split(":").slice(3).join(":");
    for (const c of [...set]) {
      if (kind === "book") void this.bookMessage(c, `book:${id}`, msg);
      else if (kind === "px") this.throttledPx(c, id, raw);
      else {
        const name = kind === "user" ? "user" : kind === "sys" ? "sys" : `${kind}:${id}`;
        if (kind === "user" && c.owner !== id) continue; // belt and braces: only the subject's events
        this.stats.forwarded++;
        this.send(c, { ...msg, channel: name });
      }
    }
  }

  /** At most one `underlying` per ticker per interval; the latest one is sent at the end of the window. */
  private throttledPx(c: Conn, t: string, raw: string) {
    let p = c.px.get(t);
    if (!p) {
      p = { last: -Infinity, timer: null, queued: null };
      c.px.set(t, p);
    }
    const now = this.o.now();
    const out = () => JSON.stringify({ ...JSON.parse(p!.queued!), channel: `px:${t}` });
    p.queued = raw;
    if (now - p.last >= this.o.pxIntervalMs && !p.timer) {
      p.last = now;
      this.send(c, out());
      p.queued = null;
      return;
    }
    if (!p.timer) {
      p.timer = setTimeout(() => {
        p!.timer = null;
        if (!p!.queued) return;
        p!.last = this.o.now();
        this.send(c, out());
        p!.queued = null;
      }, Math.max(0, this.o.pxIntervalMs - (now - p.last)));
    }
  }
}
