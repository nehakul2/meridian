/**
 * MER-42: Pyth Hermes client and stored oracle updates (D1, D2, A2, spec 5 `oracle_updates`).
 *
 * `GET {HERMES_URL}/v2/updates/price/{publish_time}?ids[]={feed}&encoding=base64&parsed=true`
 * returns the first signed update with `publish_time >=` the requested time. The update is
 * stored keyed (symbol, date, purpose) and every later call returns the stored bytes, so
 * retries resubmit the identical update and never a newer one (D2, SJ-02).
 */
import type { IsoDate } from "../time.js";
import type { OracleUpdateRow, Purpose, Store } from "../store/types.js";
import { FetchLike, getJson, NotFound, VendorError } from "../vendors/http.js";

export interface HermesUpdate {
  publishTime: number;
  priceRaw: bigint;
  expo: number;
  conf: bigint;
  /** The binary accumulator update, as Hermes returned it. */
  vaa: Uint8Array;
}

export interface HermesApi {
  /** First update with publish_time >= target, or null when none exists yet. */
  updateAtOrAfter(feedIdHex: string, targetTime: number): Promise<HermesUpdate | null>;
}

export class HermesClient implements HermesApi {
  private readonly base: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: { baseUrl: string; timeoutMs?: number; fetch?: FetchLike }) {
    this.base = opts.baseUrl.replace(/\/$/, "");
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  async updateAtOrAfter(feedIdHex: string, targetTime: number): Promise<HermesUpdate | null> {
    const feed = feedIdHex.replace(/^0x/, "");
    let body: Record<string, any>;
    try {
      body = (await getJson(
        "hermes",
        this.fetchFn,
        `${this.base}/v2/updates/price/${targetTime}?ids[]=${feed}&encoding=base64&parsed=true`,
        { timeoutMs: this.timeoutMs, what: "price update" },
      )) as Record<string, any>;
    } catch (e) {
      if (e instanceof NotFound) return null;
      throw e;
    }
    const parsed = (body.parsed ?? []) as Record<string, any>[];
    const p = parsed.find((x) => String(x.id).replace(/^0x/, "") === feed);
    const data = (body.binary?.data ?? []) as string[];
    if (!p || data.length === 0) return null;
    return {
      publishTime: Number(p.price.publish_time),
      priceRaw: BigInt(p.price.price),
      expo: Number(p.price.expo),
      conf: BigInt(p.price.conf),
      vaa: new Uint8Array(Buffer.from(data[0]!, "base64")),
    };
  }
}

export class UpdateOutOfWindow extends Error {
  constructor(public readonly publishTime: number, public readonly targetTime: number, public readonly windowS: number) {
    super(`first update after ${targetTime} is at ${publishTime}, beyond the ${windowS}s window`);
  }
}

export class NoUpdateYet extends Error {
  constructor(public readonly targetTime: number) {
    super(`no Hermes update at or after ${targetTime} yet`);
  }
}

/**
 * Returns the stored update for (symbol, date, purpose); otherwise fetches the first
 * update at or after `targetTime`, refuses (does not store) one beyond
 * `targetTime + windowS`, and stores it. Hermes errors surface as VendorError (retryable
 * for 5xx and timeouts).
 */
export async function fetchFirstUpdateAtOrAfter(
  store: Store,
  hermes: HermesApi,
  q: { symbol: string; date: IsoDate; purpose: Purpose; feedIdHex: string; targetTime: number; windowS: number; now: number },
): Promise<OracleUpdateRow> {
  const stored = await store.getOracleUpdate(q.symbol, q.date, q.purpose);
  if (stored) return stored;
  const u = await hermes.updateAtOrAfter(q.feedIdHex, q.targetTime);
  if (!u) throw new NoUpdateYet(q.targetTime);
  if (u.publishTime < q.targetTime) {
    throw new VendorError("hermes", `returned an update at ${u.publishTime} before the target ${q.targetTime}`, true);
  }
  if (u.publishTime > q.targetTime + q.windowS) throw new UpdateOutOfWindow(u.publishTime, q.targetTime, q.windowS);
  return store.putOracleUpdate({
    symbol: q.symbol,
    tradingDate: q.date,
    purpose: q.purpose,
    targetTime: q.targetTime,
    publishTime: u.publishTime,
    priceRaw: u.priceRaw,
    expo: u.expo,
    conf: u.conf,
    vaa: u.vaa,
    fetchedAt: q.now,
  });
}
