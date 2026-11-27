/**
 * Massive (formerly Polygon.io) client: official close (D3, D13), ATM implied vol (D9,
 * MER-49), market status, splits and dividends (D25). One key, `MASSIVE_API_KEY`.
 *
 * Endpoints (Polygon-compatible REST, base `MASSIVE_BASE_URL`):
 * - official close: `GET /v1/open-close/{ticker}/{date}`, field `close` (the primary
 *   exchange's official closing price; MER-48 confirms publication latency)
 * - ATM IV: `GET /v3/snapshot/options/{ticker}?expiration_date.gte={date}&limit=250`,
 *   field `results[].implied_volatility` with `details.{strike_price, expiration_date,
 *   contract_type}`; ATM = strike nearest the previous close on the nearest expiry,
 *   mean of call and put IV
 * - market status: `GET /v1/marketstatus/upcoming` (holidays and early closes)
 * - splits: `GET /v3/reference/splits?ticker={t}&execution_date={date}`
 * - dividends: `GET /v3/reference/dividends?ticker={t}&ex_dividend_date={date}`
 */
import type { CorporateActionFeed } from "../calendar.js";
import type { IsoDate } from "../time.js";
import { FetchLike, getJson, NotFound, toCents } from "./http.js";

export interface MassiveOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}

export interface OfficialCloseQuote {
  cents: bigint;
  /** Vendor's own status / timestamp, kept as evidence. */
  raw: unknown;
}

export interface OfficialCloseSource {
  readonly name: "MASSIVE" | "DATABENTO";
  /** The official closing-auction price, or null if not published yet. */
  officialClose(symbol: string, date: IsoDate): Promise<OfficialCloseQuote | null>;
}

export interface IvSnapshot {
  ivBps: bigint;
  expiry: IsoDate;
  strikeCents: bigint;
  source: string;
}

export interface IvSource {
  atmImpliedVol(symbol: string, date: IsoDate, prevCloseCents: bigint): Promise<IvSnapshot | null>;
}

type Rec = Record<string, unknown>;

export class MassiveClient implements OfficialCloseSource, IvSource, CorporateActionFeed {
  readonly name = "MASSIVE" as const;
  private readonly base: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly opts: MassiveOptions) {
    this.base = (opts.baseUrl ?? "https://api.massive.com").replace(/\/$/, "");
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  private get(path: string, what: string): Promise<unknown> {
    const sep = path.includes("?") ? "&" : "?";
    return getJson("massive", this.fetchFn, `${this.base}${path}${sep}apiKey=${encodeURIComponent(this.opts.apiKey)}`, {
      timeoutMs: this.timeoutMs,
      what,
    });
  }

  async officialClose(symbol: string, date: IsoDate): Promise<OfficialCloseQuote | null> {
    let body: Rec;
    try {
      body = (await this.get(`/v1/open-close/${encodeURIComponent(symbol)}/${date}?adjusted=false`, "open-close")) as Rec;
    } catch (e) {
      if (e instanceof NotFound) return null;
      throw e;
    }
    if (body.status !== "OK" || body.close === undefined || body.close === null) return null;
    return { cents: toCents(body.close), raw: { status: body.status, from: body.from, close: body.close } };
  }

  async atmImpliedVol(symbol: string, date: IsoDate, prevCloseCents: bigint): Promise<IvSnapshot | null> {
    let body: Rec;
    try {
      body = (await this.get(
        `/v3/snapshot/options/${encodeURIComponent(symbol)}?expiration_date.gte=${date}&limit=250`,
        "options snapshot",
      )) as Rec;
    } catch (e) {
      if (e instanceof NotFound) return null;
      throw e;
    }
    return pickAtmIv(Array.isArray(body.results) ? (body.results as Rec[]) : [], prevCloseCents);
  }

  async marketStatus(date: IsoDate): Promise<string | null> {
    const body = await this.get(`/v1/marketstatus/upcoming`, "market status");
    if (!Array.isArray(body)) return null;
    const rows = (body as Rec[]).filter((r) => r.date === date && (r.exchange === "NASDAQ" || r.exchange === "NYSE"));
    if (rows.length === 0) return "open";
    return String(rows[0]!.status ?? "closed");
  }

  async splits(symbol: string, date: IsoDate): Promise<{ kind: string }[]> {
    const body = (await this.get(
      `/v3/reference/splits?ticker=${encodeURIComponent(symbol)}&execution_date=${date}`,
      "splits",
    )) as Rec;
    const rows = Array.isArray(body.results) ? (body.results as Rec[]) : [];
    return rows.map((r) => ({
      kind: Number(r.split_from) > Number(r.split_to) ? "REVERSE_SPLIT" : "SPLIT",
    }));
  }

  async dividends(symbol: string, date: IsoDate): Promise<{ cashAmount: string; special: boolean }[]> {
    const body = (await this.get(
      `/v3/reference/dividends?ticker=${encodeURIComponent(symbol)}&ex_dividend_date=${date}`,
      "dividends",
    )) as Rec;
    const rows = Array.isArray(body.results) ? (body.results as Rec[]) : [];
    // dividend_type: CD regular cash, SC special cash, LT/ST capital gains.
    return rows.map((r) => ({ cashAmount: String(r.cash_amount), special: r.dividend_type === "SC" }));
  }
}

/**
 * ATM IV from an options chain snapshot: nearest expiry, strike nearest the previous
 * close (ties to the lower strike), mean of the call and put IV present. IV arrives as a
 * decimal fraction (0.3512); it is converted to integer bps from its decimal string, so
 * no float rounding enters the frozen input.
 */
export function pickAtmIv(results: Rec[], prevCloseCents: bigint): IvSnapshot | null {
  const rows = results
    .map((r) => {
      const d = (r.details ?? {}) as Rec;
      const iv = r.implied_volatility;
      if (iv === undefined || iv === null || d.expiration_date === undefined) return null;
      let strikeCents: bigint;
      let ivBps: bigint;
      try {
        strikeCents = toCents(d.strike_price);
        ivBps = fractionToBps(iv);
      } catch {
        return null;
      }
      if (ivBps <= 0n) return null;
      return { expiry: String(d.expiration_date), strikeCents, ivBps, type: String(d.contract_type) };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (rows.length === 0) return null;
  const expiry = rows.map((r) => r.expiry).sort()[0]!;
  const sameExpiry = rows.filter((r) => r.expiry === expiry);
  const dist = (s: bigint) => (s > prevCloseCents ? s - prevCloseCents : prevCloseCents - s);
  let best = sameExpiry[0]!.strikeCents;
  for (const r of sameExpiry) {
    const d = dist(r.strikeCents);
    if (d < dist(best) || (d === dist(best) && r.strikeCents < best)) best = r.strikeCents;
  }
  const atm = sameExpiry.filter((r) => r.strikeCents === best);
  const sum = atm.reduce((a, r) => a + r.ivBps, 0n);
  return {
    ivBps: (sum + BigInt(atm.length) / 2n) / BigInt(atm.length),
    expiry,
    strikeCents: best,
    source: "MASSIVE /v3/snapshot/options implied_volatility",
  };
}

/** "0.3512" (or 0.3512) → 3512 bps, half-up on the 5th decimal. */
export function fractionToBps(v: unknown): bigint {
  const s = typeof v === "number" ? String(v) : String(v);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`not a fraction: ${s}`);
  const frac = (m[2] ?? "").padEnd(5, "0");
  const whole = BigInt(m[1]!) * 10_000n + BigInt(frac.slice(0, 4));
  return Number(frac[4]) >= 5 ? whole + 1n : whole;
}
