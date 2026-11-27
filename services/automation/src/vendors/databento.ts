/**
 * Databento client: the second, independent source of the official closing-auction
 * print (D13). `DATABENTO_API_KEY` (HTTP basic auth, key as user name).
 *
 * Query: `GET /v0/timeseries.get_range?dataset={DATABENTO_DATASET}&schema=statistics
 * &symbols={t}&start={date}T20:00&end={date}T23:59&encoding=json&pretty_px=true` and
 * take the last record with `stat_type = 11` (CLOSE_PRICE, the official close). Dataset
 * defaults to `XNAS.ITCH` (Nasdaq TotalView, where all MAG7 list). The exact dataset and
 * stat type are confirmed by the MER-48 spike; both are configurable.
 */
import { etToUnix, IsoDate } from "../time.js";
import { FetchLike, NotFound, toCents, VendorError } from "./http.js";
import type { OfficialCloseQuote, OfficialCloseSource } from "./massive.js";

export interface DatabentoOptions {
  apiKey: string;
  baseUrl?: string;
  dataset?: string;
  closeStatType?: number;
  timeoutMs?: number;
  fetch?: FetchLike;
}

export class DatabentoClient implements OfficialCloseSource {
  readonly name = "DATABENTO" as const;
  private readonly base: string;
  private readonly fetchFn: FetchLike;

  constructor(private readonly opts: DatabentoOptions) {
    this.base = (opts.baseUrl ?? "https://hist.databento.com").replace(/\/$/, "");
    this.fetchFn = opts.fetch ?? fetch;
  }

  async officialClose(symbol: string, date: IsoDate): Promise<OfficialCloseQuote | null> {
    const start = new Date(etToUnix(date, 13, 0) * 1000).toISOString();
    const end = new Date(etToUnix(date, 20, 0) * 1000).toISOString();
    const qs = new URLSearchParams({
      dataset: this.opts.dataset ?? "XNAS.ITCH",
      schema: "statistics",
      symbols: symbol,
      start,
      end,
      encoding: "json",
      pretty_px: "true",
    });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 5_000);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/v0/timeseries.get_range?${qs}`, {
        headers: { authorization: `Basic ${Buffer.from(`${this.opts.apiKey}:`).toString("base64")}` },
        signal: ctl.signal,
      });
    } catch (e) {
      throw new VendorError("databento", `request failed: ${(e as Error).message}`, true);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404 || res.status === 422) return null; // range not available yet
    if (res.status === 429 || res.status >= 500) throw new VendorError("databento", `HTTP ${res.status}`, true, res.status);
    if (!res.ok) throw new VendorError("databento", `HTTP ${res.status}`, false, res.status);
    const text = await res.text();
    const want = this.opts.closeStatType ?? 11;
    let last: Record<string, unknown> | null = null;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new VendorError("databento", "invalid JSON line", true);
      }
      if (Number(rec.stat_type) === want) last = rec;
    }
    if (!last) return null;
    return { cents: toCents(last.price), raw: { ts_event: (last.hd as Record<string, unknown> | undefined)?.ts_event, price: last.price } };
  }
}

export { NotFound };
