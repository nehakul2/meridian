/** Small fetch wrapper: timeouts and typed, retry-classified errors. */

export class VendorError extends Error {
  constructor(
    public readonly vendor: string,
    message: string,
    /** True for timeouts, 429 and 5xx: the caller may try again. */
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(`${vendor}: ${message}`);
  }
}

/** 404 / "no data yet": not an error, the value simply is not published. */
export class NotFound extends Error {
  constructor(public readonly vendor: string, what: string) {
    super(`${vendor}: ${what} not found`);
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function getJson(
  vendor: string,
  fetchFn: FetchLike,
  url: string,
  opts: { timeoutMs: number; headers?: Record<string, string>; what: string },
): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(url, { headers: opts.headers, signal: ctl.signal });
  } catch (e) {
    throw new VendorError(vendor, `request failed: ${(e as Error).message}`, true);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) throw new NotFound(vendor, opts.what);
  if (res.status === 429 || res.status >= 500) {
    throw new VendorError(vendor, `HTTP ${res.status}`, true, res.status);
  }
  if (!res.ok) throw new VendorError(vendor, `HTTP ${res.status}`, false, res.status);
  try {
    return await res.json();
  } catch {
    throw new VendorError(vendor, "invalid JSON", true, res.status);
  }
}

/**
 * Exact decimal → integer cents. Accepts a JSON number or string; refuses anything that
 * is not a whole number of cents, so a vendor value is never silently rounded.
 */
export function toCents(v: unknown): bigint {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`not a price: ${JSON.stringify(v)}`);
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > 2) throw new Error(`price ${s} is not whole cents`);
  return BigInt(m[1]!) * 100n + BigInt(frac.padEnd(2, "0"));
}
