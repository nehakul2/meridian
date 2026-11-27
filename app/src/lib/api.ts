/**
 * REST client for the Phase 6 API (spec 7) and Tx Builder (spec 7.4). Errors arrive as the
 * spec envelope `{ error: { code, message, details } }` and are thrown as `ApiError`.
 */
import type {
  Claimable, HistoryItem, MarketDetail, MarketsResponse, Order, Position, Prefs, Settlements, Status, TickersResponse,
  TradeRequest, TxResponse, BookSnapshot, Trade,
} from "./types";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export type TokenSource = () => Promise<string>;

export interface ApiClient {
  status(): Promise<Status & { receivedAt: number; rttMs: number }>;
  tickers(): Promise<TickersResponse>;
  markets(symbol: string, date?: string): Promise<MarketsResponse>;
  market(id: string): Promise<MarketDetail>;
  book(id: string, view?: "YES" | "NO"): Promise<BookSnapshot>;
  trades(id: string, limit?: number): Promise<{ data: Trade[] }>;
  settlements(date: string): Promise<Settlements>;
  siwsNonce(owner: string): Promise<{ nonce: string; message: string; expiresAt: string }>;
  siwsVerify(owner: string, signature: string, message: string): Promise<{ token: string; expiresAt: string; admin?: boolean }>;
  positions(token: TokenSource, status?: "OPEN" | "SETTLED" | "ALL"): Promise<{ data: Position[] }>;
  orders(token: TokenSource, status?: "OPEN" | "ALL", marketId?: string): Promise<{ data: Order[] }>;
  history(token: TokenSource, limit?: number, before?: string): Promise<{ data: HistoryItem[]; nextBefore: string | null }>;
  claimable(token: TokenSource): Promise<Claimable>;
  prefs(token: TokenSource): Promise<Prefs>;
  putPrefs(token: TokenSource, p: Partial<Prefs>): Promise<Prefs>;
  txTrade(req: TradeRequest): Promise<TxResponse>;
  txCancel(body: { owner: string; marketId: string; orderId?: string; all?: boolean }): Promise<TxResponse>;
  txWithdraw(body: { owner: string; marketId: string }): Promise<TxResponse>;
  txRedeem(body: { owner: string; marketIds: string[] }): Promise<TxResponse>;
}

type Fetch = typeof fetch;

export function createApi(apiUrl: string, txbUrl: string, f: Fetch = (...a) => fetch(...a)): ApiClient {
  async function call<T>(base: string, method: string, path: string, body?: unknown, token?: string): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await f(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError("NETWORK", "Can't reach Meridian. Check your connection and try again.", 0);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
      throw new ApiError(e?.code ?? "HTTP_" + res.status, e?.message ?? `Request failed (${res.status})`, res.status, e?.details ?? {});
    }
    return json as T;
  }

  /** User-scoped call: a 401 means the JWT expired; get a fresh one once and retry (MER-70). */
  async function authed<T>(token: TokenSource, method: string, path: string, body?: unknown): Promise<T> {
    const t = await token();
    try {
      return await call<T>(apiUrl, method, path, body, t);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        (token as TokenSource & { invalidate?: () => void }).invalidate?.();
        return call<T>(apiUrl, method, path, body, await token());
      }
      throw e;
    }
  }

  const q = (o: Record<string, string | number | undefined>) => {
    const s = Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
    return s ? `?${s}` : "";
  };

  return {
    async status() {
      const t0 = Date.now();
      const s = await call<Status>(apiUrl, "GET", "/v1/status");
      const t1 = Date.now();
      return { ...s, receivedAt: t1, rttMs: t1 - t0 };
    },
    tickers: () => call(apiUrl, "GET", "/v1/tickers"),
    markets: (symbol, date) => call(apiUrl, "GET", `/v1/tickers/${encodeURIComponent(symbol)}/markets${q({ date })}`),
    market: (id) => call(apiUrl, "GET", `/v1/markets/${encodeURIComponent(id)}`),
    book: (id, view = "YES") => call(apiUrl, "GET", `/v1/markets/${encodeURIComponent(id)}/book${q({ depth: 20, view })}`),
    trades: (id, limit = 30) => call(apiUrl, "GET", `/v1/markets/${encodeURIComponent(id)}/trades${q({ limit })}`),
    settlements: (date) => call(apiUrl, "GET", `/v1/settlements${q({ date })}`),
    siwsNonce: (owner) => call(apiUrl, "POST", "/v1/auth/siws/nonce", { owner }),
    siwsVerify: (owner, signature, message) => call(apiUrl, "POST", "/v1/auth/siws/verify", { owner, signature, message }),
    positions: (t, status = "ALL") => authed(t, "GET", `/v1/me/positions${q({ status })}`),
    orders: (t, status = "OPEN", marketId) => authed(t, "GET", `/v1/me/orders${q({ status, marketId })}`),
    history: (t, limit = 50, before) => authed(t, "GET", `/v1/me/history${q({ limit, before })}`),
    claimable: (t) => authed(t, "GET", "/v1/me/claimable"),
    prefs: (t) => authed(t, "GET", "/v1/me/prefs"),
    putPrefs: (t, p) => authed(t, "PUT", "/v1/me/prefs", p),
    txTrade: (req) => call(txbUrl, "POST", "/v1/tx/trade", req),
    txCancel: (b) => call(txbUrl, "POST", "/v1/tx/cancel", b),
    txWithdraw: (b) => call(txbUrl, "POST", "/v1/tx/withdraw", b),
    txRedeem: (b) => call(txbUrl, "POST", "/v1/tx/redeem", b),
  };
}
