# Phase 4 coverage (MER-40 to MER-49)

The automation service (`services/automation`, component C8): trading calendar, dynamic
strikes and their frozen inputs, the Hermes client, the morning job, the settler, the
finalize / strike / prune / close-book cranks, the scheduler with its single-runner lock,
and the nightly reconcile. TypeScript on Node 22, tested with Vitest. 92 tests; the whole
suite runs in about 8 s.

The jobs that touch the chain are tested against the **real program** (`target/deploy/meridian.so`)
on LiteSVM, through the same `AccountReader` / `TxSender` / `PriceUpdatePoster` interfaces the
service uses on RPC. The SVM clock follows the test clock, so on-chain checks (halt, dispute
window, 24 h deadline) and the job timeline agree. `PgStore` is tested against a real
Postgres 16 with the migrations applied. Vendors (Massive, Databento, Hermes) are faked or
fed recorded responses; nothing calls a live API.

## Matrix coverage

| Task | Test file | Cases |
|---|---|---|
| MER-40 calendar | `calendar.test.ts`, `morning-job.test.ts` | CAL-01, CAL-02, CAL-03, CAL-04, CAL-05, CAL-07 |
| MER-41 strikes | `strikes.test.ts` | STK-01, STK-02, STK-03, STK-04, STK-05, STK-06, STK-07, STK-09, STK-10, STK-11 |
| MER-42 Hermes | `hermes.test.ts`, `morning-job.test.ts` | MKT-09, SJ-03 |
| MER-43 morning job | `morning-job.test.ts` | MKT-03, MKT-05, MKT-06, MKT-10 (plus CAL-01, CAL-02, CAL-05, ORC-18, SEC-06 for the creator key) |
| MER-44 settler | `settler.test.ts` | SJ-01 (record half), SJ-02, SJ-03, SJ-04, SJ-05, SJ-06, SJ-08, SJ-09, SJ-10, SEC-06, ORC-17, CON-07, CAL-02 |
| MER-45 cranks | `cranks.test.ts` | SJ-01 (finalize and settle half), SJ-07, CLN-07, DSP-01, DSP-06 |
| MER-46 scheduler | `scheduler.test.ts`, `pg.test.ts` | CAL-03, CAL-04, CON-07 |
| MER-47 reconcile | `reconcile.test.ts` | IDX-09 |
| MER-48 spike | `scripts/close-spike.ts` | none (spike) |
| MER-49 strike inputs | `strike-inputs.test.ts` | STK-10, ORC-18 |

Halves that wait for later phases: CLN-07's "Redis `md:book:*` keys deleted; `markets.book = NULL`"
is the Indexer and PG Writer reacting to `BookClosed` (Phase 5); this phase checks that every
book account is closed on chain. IDX-09's backfill is the PG Writer's (MER-52/53): reconcile
calls a `Backfiller` interface, tested with a stand-in that inserts once.

## Contract changes

- **`db/migrations/0001_init.sql` is the spec Section 5 schema, verbatim** (the MER-03 contract).
  Phase 0 never landed it and Phase 4 is the first phase that needs Postgres, so it lands here.
  No contract PR went first; it is a straight copy of the spec.
- **`db/migrations/0002_automation.sql` adds two Automation-owned tables** that Section 5 lacks:
  - `official_closes (symbol, trading_date)`: the official closing-auction print with both
    vendors' values and times. A CHECK makes a single-vendor or disagreeing row impossible.
    `oracle_updates` only has room for the Pyth update, and D13 needs both stored. It is also
    the source of the next day's previous close (A14, ORC-18).
  - `reconcile_reports`: one diff report per RECONCILE run.
  - an index on open alerts for the dedupe query.
- No program, IDL or event change.

## Choices made where the spec was silent

- **Previous close is the official close, not the Pyth update.** MKT-09 says the stored
  PREV_CLOSE update "equals" `prev_close_cents`; ORC-18, A14 and D3 say the previous close is
  the previous day's official close. The official close wins; the PREV_CLOSE Pyth update is
  still fetched and stored (first at or after the previous close) as the audit reference.
- **Missing previous close (MKT-10).** Vendors are asked for the previous day's print first. If
  they have nothing, the latest stored official close within 5 trading days is used with a WARN;
  otherwise the ticker is skipped with a PAGE. Vendor disagreement on the previous close also
  skips with a PAGE.
- **Vendor mismatch escalates at once.** When Massive and Databento disagree, the settler
  pages Settlement Triage and stops for that ticker. It does not keep polling in case a vendor
  corrects itself, because a later value would be a swap (spec 4.7 rule 2). A vendor that has
  not published is polled until close + 15 min.
- **`CrossCheckFailed` escalates at once** (spec 4.7 rule 4: nothing recorded, Triage gets the
  evidence). `ConfidenceTooWide` and `PublishTimeOutsideWindow` keep retrying the same stored
  bytes until close + 15 min, as SJ-02 and SJ-04 describe.
- **WARN timing.** `SETTLE_SLA_AT_RISK` (WARN) fires when the first attempt at close + 5 min does
  not record; `SETTLE_FAILED` (PAGE, "Admin override needed") at close + 15 min.
- **The strike crank acts on chain state, not on the event.** From close + 25 min the scheduler
  runs FINALIZE, STRIKE_CRANK, PRUNE and CLOSE_BOOK every minute until each reports done (or
  20:00 ET). The strike crank settles a ticker as soon as its TickerDay is FINAL, which is exactly
  when `CloseFinalized` is emitted, so a missed event cannot stall settlement.
- **A refused strike** (`ConfidenceStraddle`) raises `SETTLE_STRIKE_REFUSED` (PAGE) naming
  `admin_settle_market`, and the crank counts it as done: the multisig owns it now. Its book
  closes on a later CLOSE_BOOK run once the multisig has settled it.
- **Prune runs only after a market is settled**, per the MER-45 DoD, although the program
  allows it from `close_time` (Phase 3). Batches are cut so the owners' ledgers (and the No
  account of each BUY_NO owner) fit one transaction, 20 accounts by default.
- **Settle batching.** Four `settle_market` instructions per transaction; if a batch fails (one
  refused strike fails the whole transaction) its strikes are retried one by one.
- **Liquidity tier for a ticker with no fills is B** (spec 8.1). On launch day that is every
  ticker, so META gets $25 steps (7 strikes) instead of the worked example's $10 (9 strikes)
  until fills build up. Set `tickers.liquidity_tier_override` for launch if the worked-example
  spacing is wanted from day one.
- **RV20** is the sample standard deviation of 20 daily simple returns of official closes,
  annualised by sqrt(252), in integer fixed point. Simple and log returns differ by well under
  1 bp at daily scale, and integers keep the frozen value reproducible.
- **ATM IV from Massive**: `GET /v3/snapshot/options/{ticker}?expiration_date.gte={date}`,
  field `implied_volatility`; nearest expiry, strike nearest the previous close, mean of the call
  and put. Recorded in spec 8.1. An IV vendor error falls back to RV with a log line.
- **Corporate actions.** A `corporate_actions` row with `skip_markets` skips that ticker; so do a
  Massive split or a special cash dividend on the date. Ordinary cash dividends do not skip. A
  vendor error is retried and paged like any other morning failure, never a silent skip. If
  Massive reports the whole market closed on a calendar trading day, the morning is skipped
  with a WARN `CALENDAR_MISMATCH`.
- **Calendar source.** The NYSE/Nasdaq holiday and early-close rules (Rule 7.2 observance,
  Saturday New Year not observed, early closes on July 3, the day after Thanksgiving and
  Christmas Eve when they fall Monday to Thursday), plus an optional overrides file for one-off
  closures. 2026 matches the published schedule (251 trading days).
- **Single-runner lock** is a Postgres session advisory lock on `automation:{job}:{date}`, held
  for the run. Scheduler progress is in memory; a restart reruns the day's jobs, which is safe
  because every job checks chain state first.
- **Manual rerun** accepts only MORNING, SETTLE, FINALIZE, STRIKE_CRANK, PRUNE, CLOSE_BOOK and
  RECONCILE; anything else (admin settle, dispute resolution, pause, add strike, void) is refused
  with `NotRerunnable`.
- **Alerts** go to the `alerts` table (deduped while open per code, symbol, date and severity)
  and the log. Delivery to a pager is the Monitor's job (MER-81).
- **Keys.** The process loads the fee payer, `market_creator` and `settler` only. Cranks are
  permissionless and sign with the payer. Tests check every transaction's signers and that the
  creator and settler keys fail on admin instructions.

## Not done in this phase

- **MER-48 spike is not run.** `scripts/close-spike.ts` records both vendors' prints, their
  agreement, publication latency (live mode) and the gap to the Pyth update, and prints a
  recommended `close_tolerance_bps`. It needs `MASSIVE_API_KEY`, `DATABENTO_API_KEY`, Pyth feed
  ids and five live trading days. Until then two details stay unconfirmed: the Databento dataset
  and statistic for the official close (`XNAS.ITCH`, `stat_type = 11`, both configurable) and the
  Massive base URL (`api.massive.com`, Polygon-compatible paths).
- **Pyth feed ids** for the seven tickers are not seeded; they go in `tickers.pyth_feed_id` and
  must match `Config.tickers` on chain.
- **The RPC paths** (`RpcSender`, `RpcReader`, the Pyth Receiver poster, the ALT manager and the
  RPC chain history) are written but only unit-tested; their first real run is the devnet
  lifecycle in MER-80.
