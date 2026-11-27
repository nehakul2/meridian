# Meridian

Binary Yes/No outcome markets on MAG7 daily closes, on Solana. One Yes + one No token
always pays exactly $1.00; Yes pays if the official closing-auction price is at or above
the strike.

Design docs (architecture spec, test case matrix, MER task breakdown) live in the project
files, not in this repo. This repo follows their layout and naming: program tests are
`programs/meridian/tests/<area>.rs` and every matrix case has a test named after it
(for example `mnt_07_merge_burns_pairs_for_one_dollar_each`).

## Status

| Phase | Tasks | State |
|---|---|---|
| 1 · Program core | MER-10 to MER-15 | Built: config and roles, ticker-days, strike markets, mint/merge, invariants with a property harness, pause |
| 2 · Order book and trade paths | MER-20 to MER-25 | Built: zero-copy order book with halt at close, Buy/Sell Yes, Buy No market and limit, Sell No, cancel, withdraw, taker fee. Phoenix fallback not needed |
| 3 · Settlement, redeem, cleanup | MER-30 to MER-37 | Built: official close with the Pyth cross-check, admin override, dispute window, per-strike settle, redeem, void, prune (with the BUY_NO conversion) and close_book |
| 4 · Automation service | MER-40 onwards | Next |

See [docs/phase1-coverage.md](docs/phase1-coverage.md), [docs/phase2-coverage.md](docs/phase2-coverage.md) and [docs/phase3-coverage.md](docs/phase3-coverage.md) for which matrix cases are covered and which halves wait for later phases. Phases 2 and 3 also list their contract changes and the choices made where the spec was silent.

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

`make dev` (local validator, Postgres, Redis and services) arrives with the services in Phase 4.

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
