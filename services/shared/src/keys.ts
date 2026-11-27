/**
 * Redis layout (spec 6.1 to 6.3), shared by every component that reads or writes it.
 * Writers: the Indexer owns `md:*` except `md:alt` (Automation), `md:rl`, `md:siws` and
 * `md:jobreq` (API). Additions to the spec are listed in docs/phase5-coverage.md and
 * docs/phase6-coverage.md.
 */
export const TTL = {
  day: 7 * 86_400,
  mkt: 30 * 86_400,
  trades: 7 * 86_400,
  tday: 30 * 86_400,
  pos: 86_400,
  /** Stream dedupe markers (contract addition, see docs/phase5-coverage.md). */
  dedupe: 7 * 86_400,
  /** SIWS nonce lifetime (Phase 6). */
  siws: 300,
};

export const K = {
  dayMarkets: (d: number | string) => `md:day:${d}:markets`,
  dayStrikes: (d: number | string, t: string) => `md:day:${d}:${t}:strikes`,
  mkt: (m: string) => `md:mkt:${m}`,
  bids: (m: string) => `md:book:${m}:bids`,
  asks: (m: string) => `md:book:${m}:asks`,
  lvl: (m: string) => `md:book:${m}:lvl`,
  snap: (m: string) => `md:book:${m}:snap`,
  /** Resting orders of one book: field = order id → JSON {owner, side, price, qty, tag} (Phase 6). */
  ord: (m: string) => `md:book:${m}:ord`,
  bbo: (m: string) => `md:bbo:${m}`,
  trades: (m: string) => `md:trades:${m}`,
  tday: (t: string, d: number | string) => `md:tday:${t}:${d}`,
  px: (t: string) => `md:px:${t}`,
  pos: (o: string) => `md:pos:${o}`,
  oo: (o: string) => `md:oo:${o}`,
  bal: (o: string) => `md:bal:${o}:usdc`,
  alt: (t: string, d: number | string) => `md:alt:${t}:${d}`,
  cfg: "md:cfg",
  slot: "md:slot",
  lock: "md:lock:indexer",
  dedupe: (id: string) => `md:evk:${id}`,
  /** API rate-limit counter (spec 6.1). */
  rl: (who: string, route: string, window: "1s" | "60s", start: number) => `md:rl:${who}:${route}:${window}:${start}`,
  /** SIWS nonce, single use (Phase 6). */
  siws: (nonce: string) => `md:siws:${nonce}`,
  /** Manual job rerun requests from the admin route, consumed by Automation (Phase 6). */
  jobreq: "md:jobreq",
  ch: {
    book: (m: string) => `md:ch:book:${m}`,
    trades: (m: string) => `md:ch:trades:${m}`,
    market: (m: string) => `md:ch:market:${m}`,
    px: (t: string) => `md:ch:px:${t}`,
    user: (o: string) => `md:ch:user:${o}`,
    sys: "md:ch:sys",
  },
};
