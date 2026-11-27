# Phase 5 coverage (MER-50 to MER-54)

Two services and the code they share:

- **Indexer** (`services/indexer`, component C6): decodes program events, appends them to the
  `md:events` stream, projects the Redis read model (spec 6.1) and publishes deltas (spec 6.2),
  runs as active + hot standby on `md:lock:indexer`, backfills, and tracks finality.
- **PG Writer** (`services/pg-writer`, component C7): consumer group `pgw` on `md:events`;
  writes every chain-derived table in spec 5, detects per-market `seq` gaps, and handles reorgs.
- **Shared** (`services/shared/src`): the stream entry format and the positions / P&L engine.
  Both services run the same engine, so `md:pos` and `positions` agree.

TypeScript, Node 22+ (CI on Node 24), Vitest. Indexer 20 tests (~2 s), PG Writer 17 tests (~6 s),
against a real Redis 7 and Postgres 16 (CI service containers, or local throwaway servers).

**The tests run on events recorded from the real program.** `services/indexer/scripts/record-fixture.rec.ts`
runs one META day on LiteSVM against `target/deploy/meridian.so`, using the automation jobs for the
morning, settlement and cleanup and direct instructions for trades, and saves each transaction as
RPC `getTransaction` returns it (`test/fixtures/day.json`, 44 transactions, every spec 4.6 event kind).
The scenario is described at the top of the script; its numbers are what the tests check by hand.
Golden files (`day.events.json`, `day.redis.json`, `pg-writer/test/fixtures/day.tables.json`) are
regenerated with `UPDATE_GOLDEN=1` after re-recording. The suites need neither the program build
nor LiteSVM.

## Matrix coverage

| Task | Test file | Cases |
|---|---|---|
| MER-50 decoder | `services/indexer/test/decoder.test.ts` | IDX-01 (decode half), IDX-03, IDX-10 |
| MER-51 projector | `services/indexer/test/projector.test.ts` | IDX-01 (Redis half), IDX-05 (Redis half), IDX-07, IDX-10, TRD-16 (BBO half) |
| MER-52 leader | `services/indexer/test/leader.test.ts` | IDX-06 |
| MER-53 consumer | `services/pg-writer/test/consumer.test.ts` | IDX-01 (PG half), IDX-03, IDX-04, IDX-05, SCL-07 |
| MER-54 positions | `services/pg-writer/test/positions.test.ts` | IDX-02, IDX-08, POS-05 (data half) |

Halves that wait for later phases:

- **TRD-16** asserts the API response (`GET markets ... view=NO`) and the Buy No quote: Phase 6.
  This phase checks `md:bbo` carries `no_bid = 100 − ask` and `no_ask = 100 − bid` (36 / 39 for
  a 61 / 64 book).
- **IDX-02** also reads `/v1/me/history`, and **POS-05** reads `/v1/me/positions` and the UI:
  Phases 6 and 7. This phase checks `fills.taker_intent` / `maker_intent`, `orders.intent`, and
  that the position view is `BOTH_PENDING` while a Buy No limit rests.
- **IDX-05**'s "client receives correction" is published here (`book_snapshot` with
  `correction: true` on `md:ch:book:{m}`, and `position` messages on `md:ch:user:{o}`); the WS
  Gateway forwarding them is Phase 6.
- **SCL-07** asks for p95 < 2 s "under SCL-03 load" (Phase 8 load tests). Here: ten copies of the
  recorded day appended while the consumer runs (about 1,600 entries), p95 lag measured from each
  entry's stream id to its commit.
- **CLN-07** (Phase 4 left this half): `md:book:{m}:*` deleted and `markets.book = NULL` on
  `BookClosed` are both tested here.
- **IDX-09**'s backfill (Phase 4 used a stand-in): the PG Writer side is `PgWriter.handle` replaying
  a backfilled instruction; the automation reconcile is not rewired to it in this phase.

## Contract changes

No program, IDL or SQL change. The Redis layout gains a few things the spec did not name:

- **Stream entry fields `n` and `block_time`** in addition to spec 6.3's `sig, ix, ev, slot,
  commitment, kind, payload`. `n` is the number of events the instruction emitted, so the PG
  Writer can apply whole instructions (intent mapping needs to see a Buy No's `PairMinted` and its
  fills together). `block_time` fills `fills.block_time` and the other `*_time` columns.
- **Control entries** on `md:events` with `kind = Finalized` or `Dropped` (`ix = ev = -1`,
  `payload = {}`): how the Indexer tells the PG Writer a signature was finalized, or never was.
- **`md:evk:{sig}:{ix}:{ev}:{commitment}`** (7-day TTL): dedupe marker set in the same Lua script
  as the `XADD`, so a replay, a backfill or a second leader never adds a duplicate entry.
- **`md:backfill`** stream: the PG Writer's gap requests (`market, from_seq, to_seq`), consumed by
  the Indexer leader (group `indexer`).
- `md:mkt:{m}` also holds `vault, book, ticker_day, settle_price`; `md:tday:{t}:{d}` also holds the
  raw price, expo, conf, override flag, dispute result and original price (D8); `md:pos:{o}` values
  also hold the engine state (`yes_cost, no_cost, realized, pending_no, redeemed, last_seq`) next to
  spec 6.1's `{yes, no, ledger_usdc, ledger_yes, avg_yes, avg_no}`.

## Choices made where the spec was silent

- **Events live in inner instructions, not logs.** The program emits with `emit_cpi!`, so the
  Indexer subscribes to program logs only to learn signatures, then reads the transaction and
  decodes its inner instructions. Failed transactions are skipped (their CPIs rolled back).
- **The book is projected from events, not by diffing the OrderBook account.** `OrderPlaced`
  carries the rested quantity, a `Fill` reduces the maker's level, a cancel (except an IOC
  remainder, which never rested) reduces the order's level. This makes snapshot, delta and the
  market's `seq` the same number and makes replays deterministic. `Projector.resyncBook` can still
  overwrite levels from a decoded OrderBook account.
- **Idempotent projection.** A market event whose `seq` is not above `md:mkt:{m}.seq` is skipped;
  an instruction is applied in one MULTI, so it is all or nothing.
- **Fencing.** The stream append checks the lease token inside Lua; projector writes run under
  `WATCH md:lock:indexer`. A renewal touches the watched key, so an aborted MULTI is retried while
  the lease is still ours.
- **Gaps.** The PG Writer holds instructions after a gap and asks for a backfill once per gap;
  the Indexer re-reads the market's signatures, appends what is missing (dedupe skips the rest)
  and, if a late event landed behind newer ones, rebuilds the market's Redis state from its RPC
  history.
- **Reorgs.** The Indexer remembers confirmed signatures until the finalized slot passes them,
  then asks `getSignatureStatuses`: finalized → `Finalized` entry; missing or failed → `Dropped`
  entry and a rebuild of the touched markets in Redis. The PG Writer deletes the signature's
  `chain_events` and rebuilds orders, fills, mint/merge/redeem, candles, counters and positions of
  each touched market by replaying `chain_events` (ticker-day rows likewise). The pending set is in
  memory: a signature dropped while the Indexer restarts is left to the nightly reconcile.
- **Positions (A29, D31).** Average cost with taker fees. A Buy No books `(100 − yes fill) cents`
  per No (plus fee). A **direct mint** costs $1.00 a pair and is split **50/50** between the Yes and
  No legs (the spec does not say; a merge of the same pair is P&L-neutral either way). Sell No
  realizes `(100 − yes price) − fee − No basis`. Redeem realizes `paid − basis` (a losing side
  realizes `−basis`). Unrealized P&L marks Yes at the mark and No at `100 − mark`.
- **Buy No limit (A10, D15).** The No of a resting Buy No carries exactly $1.00 until its Yes
  sells, tracked as `pending_no`, so cancels and prunes (which merge the pair back for $1.00) leave
  no P&L and the filled part keeps its `1 − p` basis. Postgres has no column for it; it is derived
  from open BUY_NO orders. Position side is `BOTH_PENDING` while `pending_no > 0`.
- **Ledger balances.** Maker proceeds (USDC for asks, Yes for bids) and cancelled or pruned
  escrow go to `ledger_free_*`; a prune's Buy No conversion credits $1.00 a pair to the ledger;
  `Withdrawn` empties it. Quantities include wallet, ledger and locked tokens. Tokens moved between
  wallets outside the program are not visible to an event-based position (known limitation).
- **`markets.created_by`** is `'AUTO'` when the creator is `MARKET_CREATOR` (the automation key),
  else the creator's pubkey. **`ticker_days.close_time`** comes from `trading_calendar`, or 16:00
  America/New_York when the calendar has no row; a ticker-day row is created from `MarketCreated`
  if Automation's morning job has not written one (`tickers` must already hold the symbol).
- **Candles** are recomputed from `fills` for each touched minute (open/close by `seq`), so they
  are the same however often an instruction is replayed.
- **What is not wired yet:** `md:px` (Hermes price stream) and `md:bal` (token account subscribed
  on first WS auth) have projector methods with the spec TTLs and the 4 Hz throttle, tested here;
  the Hermes subscription and the WS-auth trigger come with the WS Gateway (Phase 6). `md:cfg` is
  written from the Config account subscription (and `paused` from Paused/Unpaused events).

## CI

- `.github/workflows/indexer.yml` and `pg-writer.yml`: Node 24, Redis 7 and Postgres 16 service
  containers, typecheck then tests. Test files run one at a time against a shared Redis (one
  pub/sub namespace).
- `automation.yml` now runs on **Node 24**: on GitHub's runners Node 20 and 22 abort with
  `std::bad_alloc` inside V8's minor GC during the LiteSVM settler suite, on every run and on
  ubuntu-24.04 as well (so the Phase 4 image pin did not fix it). Node 24 passed every probe run,
  including three full-suite runs. The automation image moves to `node:24-slim`.
