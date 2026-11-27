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
| 2 · Order book and trade paths | MER-20 to MER-25 | Next |

See [docs/phase1-coverage.md](docs/phase1-coverage.md) for which matrix cases are covered and which halves wait for later instructions.

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
    state.rs            Config, TickerDay, Market, OrderBook (header), UserLedger
    events.rs           all spec 4.6 events (emit_cpi!), each with market/slot/seq
    invariants.rs       spec 4.3 checks, run at the end of every mutating instruction
    instructions/       config, ticker_day, market, mint_merge, pause
  tests/                LiteSVM integration tests, one file per MER task
  idl/meridian.json     committed IDL (drift-checked in CI)
```

Key rules the code enforces:

- **Roles are separate keys** (D23): `admin` (Squads multisig) for config, pause and `add_strike`;
  `market_creator` for ticker-days and strikes; `settler` for `record_close` (Phase 3). The three must differ.
- **`initialize_config` can only be signed by the program's upgrade authority**, so nobody can front-run it.
- **Creation is idempotent** (A25): re-running `create_ticker_day` or `create_strike_market` is a no-op success.
- **Collateral is accounted**, and the vault check is `vault >= collateral_accounted` (D17), so a USDC donation never bricks a market.
- **Pause stops entry only** (D30): `mint_pair` (and new orders from Phase 2). `merge_pair` always works until settlement.
- **Minting runs from `mint_open_time` (≈ 08:30 ET) to `close_time`** (D26); trading-date keys are ET `YYYYMMDD` (D31).
