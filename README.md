# Meridian

Binary Yes/No outcome markets on MAG7 daily closes, on Solana. One Yes + one No token
always pays exactly $1.00; Yes pays if the official closing-auction price is at or above
the strike.

Design docs (architecture spec, test case matrix, MER task breakdown) live in the project
files, not in this repo. In this repo: [architecture rationale](docs/architecture.md),
[risks and limitations](docs/risks.md) and [open questions with the defaults built](docs/open-questions.md). This repo follows their layout and naming: program tests are
`programs/meridian/tests/<area>.rs` and every matrix case has a test named after it
(for example `mnt_07_merge_burns_pairs_for_one_dollar_each`).

## Status

| Phase | Tasks | State |
|---|---|---|
| 1 · Program core | MER-10 to MER-15 | Built: config and roles, ticker-days, strike markets, mint/merge, invariants with a property harness, pause |
| 2 · Order book and trade paths | MER-20 to MER-25 | Built: zero-copy order book with halt at close, Buy/Sell Yes, Buy No market and limit, Sell No, cancel, withdraw, taker fee. Phoenix fallback not needed |
| 3 · Settlement, redeem, cleanup | MER-30 to MER-37 | Built: official close with the Pyth cross-check, admin override, dispute window, per-strike settle, redeem, void, prune (with the BUY_NO conversion) and close_book |
| 4 · Automation service | MER-40 to MER-49 | Built: calendar, dynamic strikes and frozen inputs, Hermes client, morning job, settler (two-vendor official close), finalize / strike / prune / close-book cranks, scheduler with single-runner lock, nightly reconcile. MER-48 spike script written, not yet run |
| 5 · Indexer and PG Writer | MER-50 to MER-54 | Built: event decoder, `md:events` stream, Redis projector (book, BBO with the No view, markets, trades, ticker-days, open orders, positions), leader lease with failover and backfill, PG Writer (idempotent consumer, seq gap backfill, reorg rebuild, candles), positions with intent mapping and average-cost P&L |
| 6 · REST API, Tx Builder, WebSocket | MER-60 to MER-65 | Built: REST reads from Redis with rate limits, SIWS sign-in and `/v1/me`, Tx Builder (intent map, position guards, 500 cap, unsigned v0 txs for trade, cancel, mint, merge, withdraw, redeem, dispute), admin routes returning unsigned multisig txs with an audit log, WebSocket gateway (book snapshots and deltas, trades, prices, user channel) |
| 7 · Frontend | MER-70 to MER-76 | Built: Next.js static app with wallet connect and SIWS, markets, order book with the No view, trade panel for all four intents, portfolio with redeem, history and countdown; Playwright e2e against a stub backend |
| 8 · Devnet, monitoring, docs, load | MER-80 to MER-83 | Built: devnet deploy, lifecycle and release-smoke scripts (tested on a LiteSVM stand-in; first devnet run pending keys), monitor with SLA and health alerts, rationale / risks / open-questions docs, nightly load harness with every budget passing. Load testing added a 32-fill cap per trade |

See [docs/phase1-coverage.md](docs/phase1-coverage.md), [docs/phase2-coverage.md](docs/phase2-coverage.md), [docs/phase3-coverage.md](docs/phase3-coverage.md), [docs/phase4-coverage.md](docs/phase4-coverage.md), [docs/phase5-coverage.md](docs/phase5-coverage.md), [docs/phase6-coverage.md](docs/phase6-coverage.md), [docs/phase7-coverage.md](docs/phase7-coverage.md) and [docs/phase8-coverage.md](docs/phase8-coverage.md) for which matrix cases are covered and which halves wait for later phases. Phases 2 to 8 also list their contract changes and the choices made where the spec was silent.

## Quick start

Toolchain (checked by `make doctor`):

- Rust stable (1.85+) for tests and the IDL
- Agave (Solana CLI) **2.3.13**, which builds with platform-tools v1.48
- anchor-cli **0.31.1** (`cargo install anchor-cli --version 0.31.1 --locked`)

```sh
make doctor       # toolchain versions, no mainnet URLs in the repo
make build        # cargo build-sbf -> target/deploy/meridian.so
make test-quick   # all program tests, 200 property sequences (~30 s)
make test         # all program tests, 10,000 property sequences
make idl-check    # fails if the IDL drifts from programs/meridian/idl/meridian.json
make prop SEED=…  # replay one failing property sequence
```

### Automation service (Phase 4)

Node 22 or later (CI runs Node 24: on GitHub's runners Node 20 and 22 abort inside V8's GC
during the LiteSVM suites). The LiteSVM suites load `target/deploy/meridian.so`, so build the program first.
The Postgres suite starts a throwaway local cluster, or uses `TEST_DATABASE_URL`.

```sh
make automation-test                     # build the program, then typecheck + all service tests
cd services/automation
npm test                                 # unit, Postgres and LiteSVM suites (~8 s)
node dist/src/main.js migrate            # apply db/migrations (DATABASE_URL)
node dist/src/main.js calendar-load 2027 # fill trading_calendar for a year
node dist/src/main.js run SETTLE 2026-11-25   # manual rerun of an idempotent job
node dist/src/main.js                    # scheduler loop
```

Configuration is in `.env.example` (own RPC endpoint and keys: fee payer, `market_creator`,
`settler`; never admin). `services/automation/Dockerfile` builds the deployment image.

### Indexer and PG Writer (Phase 5)

Node 22 or later. The suites start a throwaway `redis-server` and Postgres cluster, or use
`TEST_REDIS_URL` / `TEST_DATABASE_URL`. They run on an event fixture recorded from the real
program, so they need neither the program build nor LiteSVM.

```sh
make data-test                           # typecheck + tests for services/indexer and services/pg-writer
cd services/indexer
npm test                                 # decoder, Redis projector, leader / failover (~2 s)
npm run fixture:record                   # re-record test/fixtures/day.json (needs make build and
                                         # services/automation's node_modules), then UPDATE_GOLDEN=1 npm test
node dist/indexer/src/main.js            # RPC_URL, REDIS_URL, DATABASE_URL; active or standby
cd ../pg-writer
npm test                                 # consumer (gap, reorg, replay, lag) and positions (~6 s)
node dist/pg-writer/src/main.js          # REDIS_URL, DATABASE_URL, MARKET_CREATOR
```

Code both services run (event types, the positions and P&L engine) is in `services/shared/src`.

### REST API, Tx Builder and WebSocket gateway (Phase 6)

Node 22 or later locally (CI uses 24). The API and gateway suites replay the recorded day through
the real Indexer projector into Redis, so they need no program build. The Tx Builder suites sign
every transaction they build and execute it against the real program in LiteSVM, so they need
`make build`.

```sh
make api-test                            # typecheck + tests for services/api, services/txb, services/ws
cd services/api && npm test              # reads, SIWS + /v1/me, admin routes and audit log (~5 s)
node dist/api/src/main.js                # REDIS_URL, PG_URL, PG_READ_URL, JWT_SECRET, ADMIN_SIGNERS, ADMIN_AUTHORITY
cd ../txb && npm test                    # intent map, guards, mint/merge/withdraw/redeem on LiteSVM (~20 s)
node dist/txb/src/main.js                # REDIS_URL, RPC_URL, USDC_MINT, BOND_VAULT
cd ../ws && npm test                     # gateway channels, gap recovery, slow consumers (~4 s)
node dist/ws/src/main.js                 # REDIS_URL, JWT_SECRET
```

None of the three reads RPC on a request path: the API and gateway serve the `md:*` read model
(Postgres only for history), and the Tx Builder takes its blockhash and lookup table from
background caches. Each has a `Dockerfile` in its folder.

### Frontend (Phase 7)

```sh
make app-dev                             # stub backend on :8787 and the Next dev server on :3000
make app-test                            # typecheck, component tests, static build, Playwright
```

### Devnet (Phase 8)

The scripts run on devnet only: they read the cluster's genesis hash and refuse anything else
before generating a key or sending a transaction. You need:

- a funded devnet wallet as `DEPLOYER_KEYPAIR` (about 15 SOL while the 1.07 MB program deploys;
  most comes back),
- the keypair for the program id in the committed IDL as `PROGRAM_KEYPAIR`, or a new one switched
  in with `scripts/devnet/set-program-id.sh <keypair.json>` (rewrites `declare_id!`, `Anchor.toml`
  and the IDL, then rebuilds).

Role keys (admin, market creator, settler, automation payer) are generated under `.devnet/` on
the first run and must be kept: Config records them.

```sh
make scripts-test        # all script steps on the LiteSVM stand-in, no network needed
make deploy-devnet       # deploy, initialize Config and the test USDC mint, write deployments/devnet.json
make lifecycle-devnet    # create, mint, all 4 trade paths, record the close from Pyth, settle, redeem; prints a report
make release-devnet      # deploy + lifecycle; on failure redeploy the previous binary and open an issue
```

Run the lifecycle during US market hours: it settles from a real Pyth equity update stamped at
the close it chooses, and those feeds publish only then. Reports go to `.devnet/reports/`. The
`devnet-release` workflow runs the release smoke from GitHub with keys from the `devnet`
environment's secrets.

### Monitor (Phase 8)

```sh
make monitor-test                        # alert rules, dedupe, PAGE routing, collector on Postgres
cd services/monitor && node dist/monitor/src/main.js   # DATABASE_URL, REDIS_URL, RPC_URL, PROGRAM_ID, WS_HEALTH_URLS, ONCALL_WEBHOOK_URL
```

Alerts go to the `alerts` table (INFO / WARN / PAGE), deduplicated per (code, symbol, date);
PAGE alerts are posted once to the on-call webhook.

### Load harness (Phase 8)

```sh
make load-test                           # every budget, ~1 min at LOAD_SCALE=1
cd tests/load && LOAD_SCALE=5 npx vitest run   # the nightly size
```

It runs the program on LiteSVM with the real Indexer, PG Writer, API, Tx Builder and gateway in
one process, asserts each budget and writes `tests/load/out/report.{json,md}`. It runs nightly in
CI (`.github/workflows/load.yml`), not on pull requests.

### Docs

```sh
make docs-test                           # README commands exist, internal links resolve, risks wording
```

### Dependency pins

Platform-tools v1.48 ships Cargo 1.84, which cannot parse crates that use edition 2024. The
committed `Cargo.lock` was resolved with `rust-version = "1.84"` and
`CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback`, plus `blake3 = 1.5.5` and
`ahash = 0.8.12`. If you regenerate the lockfile, repeat that:

```sh
CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo update
cargo update -p blake3 --precise 1.5.5
cargo update -p ahash --precise 0.8.12
```

## Program layout

```
programs/meridian/
  src/
    lib.rs              instruction entry points
    state.rs            Config, TickerDay, Market, OrderBook (zero-copy), UserLedger, Dispute
    book.rs             matching engine: price-time priority, rest, cancel (pure, unit-tested)
    events.rs           all spec 4.6 events (emit_cpi! format), each with market/slot/seq
    invariants.rs       spec 4.3 checks, run at the end of every mutating instruction
    settlement.rs       full-precision price vs strike, confidence and tolerance checks,
                        Pyth PriceUpdateV2 reader (pure, unit-tested)
    instructions/       config, ticker_day, market (+ grow_book), mint_merge, pause,
                        trade (place_order, buy_no_*, sell_no), cancel_withdraw (+ sweep_fees),
                        close (record_close, admin_settle, raise/resolve_dispute, finalize_close),
                        settle (settle_market, admin_settle_market, void_market, redeem),
                        cleanup (prune_orders, close_book)
  tests/                LiteSVM integration tests, one file per MER task
  idl/meridian.json     committed IDL (drift-checked in CI)
```

Key rules the code enforces:

- **Roles are separate keys** (D23): `admin` (Squads multisig) for config, pause and `add_strike`;
  `market_creator` for ticker-days and strikes; `settler` for `record_close`. The three must differ.
- **`initialize_config` can only be signed by the program's upgrade authority**, so nobody can front-run it.
- **Creation is idempotent** (A25): re-running `create_ticker_day` or `create_strike_market` is a no-op success.
- **Collateral is accounted**, and the vault check is `vault >= collateral_accounted` (D17), so a USDC donation never bricks a market.
- **Pause stops entry only** (D30): `mint_pair` and every trade path. `merge_pair`, cancels and `withdraw` always work.
- **Trading halts on-chain at `close_time`** (D12): every trade path requires `open_time <= now < close_time` by the chain clock.
- **Makers are paid into their `UserLedger`** (R4.6); the taker passes the makers' ledgers as remaining accounts, and `withdraw` moves free balances to the wallet.
- **A new market's book is grown after creation**: `create_strike_market` + 8 × `grow_book` in one transaction (an instruction can allocate at most 10 KiB).
- **Minting runs from `mint_open_time` (≈ 08:30 ET) to `close_time`** (D26); trading-date keys are ET `YYYYMMDD` (D31).
- **One close per ticker-day, the official closing-auction price** (D3, D11, D13): `record_close` (settler only) accepts it only next to a fully verified Pyth update stamped in `[close_time, close_time + ε]` with `conf/price ≤ 10 bps`, and within `max(conf, 20 bps)` of that update.
- **Every close is provisional for 20 minutes** (D8): anyone can dispute with a 100 USDC bond, the multisig upholds or corrects once, and after 24 h without action the price stands and the bond goes back. Strikes settle only from a FINAL price.
- **Admin override** opens at `close_time + 30 min` while the close is unrecorded (D4), and goes through the same window.
- **Settlement is permissionless per strike** (D10); a strike inside the confidence band is refused and goes to the multisig (`admin_settle_market`, D27).
- **Redeem works forever**, while paused and after the book is closed; `prune_orders` returns resting funds after the close, converting unfilled Buy No pairs to USDC (D15); `close_book` returns the book's rent to the automation wallet (D29).
