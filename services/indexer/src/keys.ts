/** Redis layout owned by the Indexer (spec 6.1 to 6.3). */
export const TTL = {
  day: 7 * 86_400,
  mkt: 30 * 86_400,
  trades: 7 * 86_400,
  tday: 30 * 86_400,
  pos: 86_400,
  /** Stream dedupe markers (contract addition, see docs/phase5-coverage.md). */
  dedupe: 7 * 86_400,
};

export const K = {
  dayMarkets: (d: number | string) => `md:day:${d}:markets`,
  dayStrikes: (d: number | string, t: string) => `md:day:${d}:${t}:strikes`,
  mkt: (m: string) => `md:mkt:${m}`,
  bids: (m: string) => `md:book:${m}:bids`,
  asks: (m: string) => `md:book:${m}:asks`,
  lvl: (m: string) => `md:book:${m}:lvl`,
  snap: (m: string) => `md:book:${m}:snap`,
  bbo: (m: string) => `md:bbo:${m}`,
  trades: (m: string) => `md:trades:${m}`,
  tday: (t: string, d: number | string) => `md:tday:${t}:${d}`,
  pos: (o: string) => `md:pos:${o}`,
  oo: (o: string) => `md:oo:${o}`,
  cfg: "md:cfg",
  slot: "md:slot",
  lock: "md:lock:indexer",
  dedupe: (id: string) => `md:evk:${id}`,
  ch: {
    book: (m: string) => `md:ch:book:${m}`,
    trades: (m: string) => `md:ch:trades:${m}`,
    market: (m: string) => `md:ch:market:${m}`,
    user: (o: string) => `md:ch:user:${o}`,
    sys: "md:ch:sys",
  },
};
