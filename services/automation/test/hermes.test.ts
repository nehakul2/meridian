// MER-42: Hermes client and stored oracle updates.
import { describe, expect, it } from "vitest";
import { fetchFirstUpdateAtOrAfter, HermesClient, NoUpdateYet, UpdateOutOfWindow } from "../src/oracle/hermes.js";
import { MemoryStore } from "../src/store/memory.js";
import { VendorError } from "../src/vendors/http.js";
import { etToUnix } from "../src/time.js";
import { calendar2026 } from "./helpers/fakes.js";

const FEED = "ab".repeat(32);
const CLOSE = etToUnix("2026-11-25", 16, 0);

/** A fake Hermes HTTP server: updates sorted by publish time; serves the first at or after the path's timestamp. */
function hermesHttp(updates: { t: number; price: string; bytes: string }[], opts: { status?: number } = {}) {
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    calls.push(url);
    if (opts.status) return new Response("err", { status: opts.status });
    const t = Number(/\/v2\/updates\/price\/(\d+)/.exec(url)![1]);
    const u = updates.find((x) => x.t >= t);
    if (!u) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    return new Response(JSON.stringify({
      binary: { encoding: "base64", data: [Buffer.from(u.bytes).toString("base64")] },
      parsed: [{ id: FEED, price: { price: u.price, conf: "6851", expo: -5, publish_time: u.t } }],
    }));
  };
  return { calls, client: new HermesClient({ baseUrl: "https://hermes.test", fetch: fetchFn as typeof fetch }) };
}

const q = (over: Partial<Parameters<typeof fetchFirstUpdateAtOrAfter>[2]> = {}) => ({
  symbol: "META", date: "2026-11-25", purpose: "SETTLE" as const, feedIdHex: FEED, targetTime: CLOSE, windowS: 5, now: CLOSE + 300, ...over,
});

describe("Hermes", () => {
  it("picks the first update at or after the target, not the latest", async () => {
    const h = hermesHttp([
      { t: CLOSE - 1, price: "68400000", bytes: "before" },
      { t: CLOSE + 2, price: "68512000", bytes: "first" },
      { t: CLOSE + 4, price: "68600000", bytes: "later" },
    ]);
    const row = await fetchFirstUpdateAtOrAfter(new MemoryStore(), h.client, q());
    expect(row.publishTime).toBe(CLOSE + 2);
    expect(row.priceRaw).toBe(68512000n);
    expect(Buffer.from(row.vaa).toString()).toBe("first");
    expect(h.calls[0]).toContain(`/v2/updates/price/${CLOSE}?ids[]=${FEED}`);
  });

  it("SJ-03 the stored row is returned on the second call with identical bytes; Hermes is not asked again", async () => {
    const store = new MemoryStore();
    const h = hermesHttp([{ t: CLOSE + 1, price: "68512000", bytes: "u1" }]);
    const a = await fetchFirstUpdateAtOrAfter(store, h.client, q());
    const h2 = hermesHttp([{ t: CLOSE + 1, price: "99999999", bytes: "newer" }]);
    const b = await fetchFirstUpdateAtOrAfter(store, h2.client, q());
    expect(Buffer.from(b.vaa).equals(Buffer.from(a.vaa))).toBe(true);
    expect(h2.calls).toHaveLength(0);
  });

  it("an update beyond target + window is refused and not stored", async () => {
    const store = new MemoryStore();
    const h = hermesHttp([{ t: CLOSE + 40, price: "68512000", bytes: "late" }]);
    await expect(fetchFirstUpdateAtOrAfter(store, h.client, q())).rejects.toBeInstanceOf(UpdateOutOfWindow);
    expect(await store.getOracleUpdate("META", "2026-11-25", "SETTLE")).toBeNull();
  });

  it("no update yet is a typed, retryable condition", async () => {
    const h = hermesHttp([]);
    await expect(fetchFirstUpdateAtOrAfter(new MemoryStore(), h.client, q())).rejects.toBeInstanceOf(NoUpdateYet);
  });

  it("Hermes 5xx surfaces a retryable error; 4xx does not", async () => {
    const h = hermesHttp([], { status: 503 });
    await expect(h.client.updateAtOrAfter(FEED, CLOSE)).rejects.toMatchObject({ retryable: true, status: 503 });
    const h4 = hermesHttp([], { status: 400 });
    await expect(h4.client.updateAtOrAfter(FEED, CLOSE)).rejects.toMatchObject({ retryable: false });
    await expect(h4.client.updateAtOrAfter(FEED, CLOSE)).rejects.toBeInstanceOf(VendorError);
  });

  it("timeouts are retryable", async () => {
    const slow = new HermesClient({
      baseUrl: "https://hermes.test", timeoutMs: 20,
      fetch: ((_u: string, init?: RequestInit) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as typeof fetch,
    });
    await expect(slow.updateAtOrAfter(FEED, CLOSE)).rejects.toMatchObject({ retryable: true });
  });

  it("MKT-09 previous-close path targets the previous trading day's close_time (Friday half-day for Monday)", async () => {
    const cal = calendar2026();
    const prevClose = cal.closeTime(cal.previousTradingDay("2026-11-30"));
    expect(prevClose).toBe(Date.parse("2026-11-27T18:00:00Z") / 1000);
    const h = hermesHttp([{ t: prevClose + 1, price: "68000000", bytes: "fri" }]);
    const store = new MemoryStore();
    const row = await fetchFirstUpdateAtOrAfter(store, h.client, q({ date: "2026-11-30", purpose: "PREV_CLOSE", targetTime: prevClose }));
    expect(row.targetTime).toBe(prevClose);
    expect(row.purpose).toBe("PREV_CLOSE");
    // A SETTLE row for the same day is separate.
    expect(await store.getOracleUpdate("META", "2026-11-30", "SETTLE")).toBeNull();
  });
});
