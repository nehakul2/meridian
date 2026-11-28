# Phase 8 coverage (MER-80 to MER-83)

Devnet scripts, monitoring, docs and the load harness. Devnet itself is not reachable from the
build environment, so everything here is verified against a LiteSVM stand-in that implements
the same `Cluster` interface the scripts use on devnet (real program, controllable clock, fake
Pyth updates). The first real devnet run needs a funded wallet and the program keypair (README
"Devnet").

```
make scripts-test   # devnet scripts on the LiteSVM stand-in (~60 s)
make monitor-test   # alert rules, dedupe, routing, collector on Postgres (~5 s)
make load-test      # load harness, all budgets (~1 min at LOAD_SCALE=1)
make docs-test      # README commands, links, risks wording
```

## Matrix coverage

| Task | Test file | Cases |
|---|---|---|
| MER-80 devnet deploy and lifecycle | `scripts/__tests__/devnet-lifecycle.test.ts` | E2E-01, E2E-05, E2E-06, E2E-07, DLC-04, DLC-05, AGT-10 |
| MER-81 monitor | `services/monitor/test/rules.test.ts` | SJ-05, MKT-06 |
| MER-82 docs | `docs/__tests__/docs.test.ts` | none (unit test only) |
| MER-83 load | `tests/load/load.test.ts` | CON-01, SCL-01 to SCL-06, SCL-07, SCL-08, SCL-09; AST-08 reported as n/a until Phase 10 |
| Fill cap (found by MER-83) | `programs/meridian/tests/clob_place_order.rs` (`scl_06_*`), `services/txb/test/intent-map.test.ts` | SCL-06 |

## Load results (LOAD_SCALE=1, 4-core container)

| Case | Measured | Budget |
|---|---|---|
| SCL-05 morning, 49 markets | 0.9 s wall, 0.64 SOL rent per market | before 08:30 |
| CON-01 1,000 mixed txs from 200 wallets on one market | 0 invariant violations | 0 |
| SCL-01 API read p99 (server), one instance at 500 req/s | 11 ms | 20 ms |
| SCL-02 Tx Builder p99 (server) at 500 builds/s | 17 ms | 30 ms |
| SCL-03 fill confirmed to WS client p95, 200 clients | 5 ms, 0 seq gaps | 150 ms |
| SCL-07 event to Postgres p95 | 10 ms | 2 s |
| SCL-06 sweep of a full 784-order book | 32 fills, 295k CU, partial fill | within compute |
| SCL-09 Indexer catch-up after 300 missed txs | 1.4 s, 0 seq mismatches | no gaps |
| SCL-04 surge: record 7 closes / settle 49 strikes | 0.03 s / 0.25 s of work | 3 min / 10 min |
| SCL-08 residual rent per day after close_book | 0.59 SOL (49 markets); 31 SOL of book rent returned | documented 0.59 |

The nightly workflow (`.github/workflows/load.yml`) runs at `LOAD_SCALE=5`, writes
`tests/load/out/report.{json,md}` and posts the table to the run summary.

## Program change: at most 32 fills per trade

The deep-book scenario (SCL-06) found that an IOC sweeping about 50 resting orders aborted with
`ProgramFailedToComplete` while plenty of compute was left. Anchor's `emit_cpi!` events are
allocated on the 32 KiB bump heap, which is never freed, and each fill emits one. The matrix
allows "caps levels per tx with a clear partial-fill result", so:

- `MAX_FILLS_PER_IX = 32` (fills plus self-trade cancels). Matching stops there.
- An IOC (market order, Buy No market, Sell No) returns a partial fill and cancels the rest as
  usual (`IocRemainder`).
- A GTC that would still cross after 32 fills is refused with the new error `FillLimitReached`
  (6058), so a crossed book can never rest.
- The Tx Builder counts the orders a trade would consume: a limit order over the cap is a 422
  `ORDER_TOO_LARGE` with `details.reason = "FILL_LIMIT"`; a market order gets
  `PARTIAL_FILL_LIKELY`. Its compute budget now also scales with fills.

## Other fixes from the load run

- `GET /v1/tickers` read each ticker's markets in a separate Redis round trip; now one.
- The Tx Builder remembers PDA derivations (bounded cache), halving build time.

## Contract changes

- New program error `FillLimitReached` (6058) appended to the IDL; no account or event changes.
- WS gateway: `GET /healthz` (`ok`, `connections`, `errors`, ...) for the monitor; `errors` counts
  failed client ops and socket errors.

## Choices and deviations

- **"Strikes unsettled" fires 10 minutes after `finalized_at`, not after the close.** With the
  20-minute dispute window (D8) strikes cannot settle before close + 20 min, so "close + 10" would
  page every day.
- **Devnet settings.** The deploy script sets a 60-second dispute window and 0 fees, and creates a
  test USDC mint (6 decimals) whose authority is the automation payer, so the lifecycle fits in one
  run. Mainnet settings stay as in the spec.
- **On devnet the official close is the Pyth price at the close**, attested by the settler key, since
  the vendor feeds (Massive, Databento) are not wired on devnet. The program's cross-check still runs.
- **Each lifecycle run uses a fresh trading-date key** so reruns never collide with an earlier
  day's accounts; the report records it. Run during US market hours (Pyth equity feeds publish
  only then); the CLI warns otherwise.
- **Release smoke.** `release` dumps the live binary first, deploys, runs the lifecycle, and on
  failure redeploys the dumped binary and opens a GitHub issue (`bug`, `release-smoke`) naming the
  failed step. The scripts refuse any cluster whose genesis hash is not devnet's (or a loopback
  test validator) before generating keys or touching anything.
- **SCL-01 per instance.** The harness runs the API in the same process as the whole stack and
  the load generator's target, so it drives one instance at 500 req/s (2,000 / `API_INSTANCES`,
  default 4). A single in-process instance saturates at about 1,200 req/s in this container.
  Measuring 2,000 req/s against one deployed endpoint needs staging infrastructure.
- **Latency is measured server-side** (Fastify's elapsed time, gateway receive time), and the load
  generator runs in a worker thread at the matrix's fixed rates.

## Not done

- No real devnet run yet: it needs a funded devnet wallet and a decision on the program keypair.
- `make dev` (MER-01) still does not exist; the frontend e2e suite still uses its stub.
