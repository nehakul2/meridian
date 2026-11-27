# Phase 6 coverage (MER-60 to MER-65)

Three public-tier services and the code they share:

- **REST API** (`services/api`, component C8): market reads from the Redis read model, SIWS sign-in
  and `/v1/me`, admin routes that return unsigned multisig transactions and audit every call.
  Fastify 5.
- **Tx Builder** (`services/txb`, component C9): maps the six user intents to program instructions,
  checks positions and state first, and returns unsigned v0 transactions for trade, cancel, mint,
  merge, withdraw, redeem and dispute. Fastify 5.
- **WebSocket gateway** (`services/ws`, component C10): book snapshots and deltas, trades, market
  status, underlying price, the authenticated user channel and system messages. `ws` 8.
- **Shared** (`services/shared/src`): Redis key names (moved here from the Indexer so every service
  uses one table), base58, SIWS message and ed25519 check, HS256 JWT, the error envelope, and market
  helpers (phase of day, No view, fees, summary copy). No runtime dependencies.

TypeScript, Node 22+ (CI on Node 24), Vitest. API 25 tests (~5 s), Tx Builder 23 (~20 s),
gateway 10 (~4 s), Indexer 21 (one added).

**How the tests get real data.** The API and gateway suites replay `indexer/test/fixtures/day.events.json`
(recorded from the real program in Phase 5) through the real Indexer projector into Redis, and load
Postgres from the PG Writer's tables. The Tx Builder suites deploy `target/deploy/meridian.so` in
LiteSVM, write the Indexer's Redis layout from chain state, then sign each transaction the API
returns and execute it. A guard or summary is only trusted when the program agrees.

## Matrix coverage

| Task | Test file | Cases |
|---|---|---|
| MER-60 reads, rate limit | `services/api/test/markets.routes.test.ts` | API-05, API-08, API-09, API-10, API-11, API-13, TRD-16 (API half), HLT-04, PSE-06, CAL-08 |
| MER-61 SIWS, `/v1/me` | `services/api/test/me.routes.test.ts` | API-06, API-07, IDX-02 (API half), POS-05 (API half), RED-10 |
| MER-62 trade intents | `services/txb/test/intent-map.test.ts` | API-01, API-02, API-03, API-04, API-05, API-14, TRD-12, TRD-14, TRD-16 (quote half), POS-01, POS-02, POS-03, POS-05, POS-06, HLT-04, PSE-06, RED-11, CON-10, SEC-08 |
| MER-63 mint, merge, cancel, withdraw, redeem | `services/txb/test/aux-routes.test.ts` | RED-09, PSE-06 (exit paths), plus mint/merge, BUY_NO cancel, void redeem, dispute |
| MER-64 admin | `services/api/test/admin.routes.test.ts` | API-12, ADM-06 |
| MER-65 gateway | `services/ws/test/gateway.test.ts` | WS-01 to WS-06, IDX-05 (client half) |

Latency checks on the fixture (not the Phase 8 load tests): API hot reads p99 < 20 ms, Tx Builder
build p99 < 30 ms, gateway publish to client p95 < 50 ms.

Still open from the matrix: UI halves (Phase 7) and load (SCL-*, Phase 8).

## Contract changes

- **Indexer** writes `md:book:{m}:ord` (order id → owner, side, price, qty, tag) for resting
  orders, so the Tx Builder can pass makers' ledgers in price-time order without RPC. Deleted on
  `BookClosed` and on market rebuild. Every `book_delta` now carries `prev_seq`, the snapshot seq
  it applies to, so the gateway can spot a lost delta (WS-02). Golden files are unchanged.
- **New Redis keys:** `md:siws:{nonce}` (TTL 300 s, `GETDEL`, single use),
  `md:rl:{who}:{route}:{1s|60s}:{start}` (rate limit windows), `md:jobreq` (admin job reruns,
  stream for Automation), `md:alt:{t}:{d}` (lookup table address per ticker-day, read only; nothing writes it yet).
- **Migration `0003_api.sql`:** `admin_audit` (caller, route, payload, status, error code).
- **New error codes** beyond spec 7.6: `NOT_SETTLED`, `OVERRIDE_TOO_EARLY`, `ALREADY_RECORDED`,
  `DISPUTE_WINDOW_CLOSED`, `NOT_RERUNNABLE` (409), `UNAVAILABLE` (503), `INTERNAL` (500). Admin
  routes reuse `UNAUTHORIZED` with HTTP 403 for a valid non-admin token.
- **Position side `BOTH`** in `/v1/me/positions` for a wallet holding Yes and No from a direct mint
  with nothing pending (spec lists YES, NO, BOTH_PENDING, FLAT).

## Choices where the spec was silent or inconsistent

- **Spec 7.4's example** gives `maxCost` 65000000 for Buy No 100 at No 35, which does not match
  qty × No price. The builder reports qty × the worst No price (+ fee), which the test executes.
- **uWebSockets.js is not on npm**, so the gateway uses `ws`. The slow-consumer rule (drop at
  1 MB buffered) and the 4 Hz price throttle are implemented in the gateway itself.
- **Admin transactions** are built by the API (no separate admin service): payer is the Squads
  vault (`ADMIN_AUTHORITY`), the blockhash is an all-zero placeholder that Squads replaces, and the
  response lists the decoded instructions for the signers to check.
- **Blockhash and lookup table** come from background RPC caches (refresh every 2 s, stale after
  30 s → 503 `UNAVAILABLE`). Each build gets a random `client_id`, so parallel builds differ.
- **Makers** are taken in price-time order plus two spares; spares are dropped until the
  transaction fits in 1,232 bytes. Compute budget is min(1.4M, 200k + 60k per maker).
- **POST_ONLY** is accepted for Yes intents only; the No paths have no post-only instruction.
- **Merge bundling** after a Sell No fill merges only min(ledger Yes, No − pending No), so a maker's
  own inventory is never merged away.
- **Fee bound** in the summary rounds the aggregate fee up once, as the program does per fill
  summed; it can exceed the charged fee by under a cent.
- **OpenAPI (MER-05)** is not written yet. API-13's "money is integer strings, prices integer
  cents" is checked by a walker over every GET response instead.

## Not wired yet

- **`md:jobreq`** is written by `POST /v1/admin/jobs/:job/run`; Automation has no consumer yet.
- **`md:bal`** and **`md:px`** are read by the gateway and Tx Builder, but nothing subscribes to the
  token accounts or Hermes for them yet. Until then `INSUFFICIENT_BALANCE` is only checked when
  `md:bal` exists, and the program remains the final check.
- **`resyncBook`** in the Indexer rebuilds the snapshot but not `md:book:{m}:ord`; a full market
  rebuild does.

## CI

`.github/workflows/api.yml` (Redis 7, Postgres 16), `txb.yml` (Rust, Solana CLI v2.3.13,
`make build`, Redis 7) and `ws.yml` (Redis 7), all on Node 24. `make api-test` runs all three
locally.
