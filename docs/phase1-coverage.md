# Phase 1 coverage (MER-10 to MER-15)

Every matrix case assigned to a Phase 1 task, the test that covers it, and anything that
waits for a later instruction. Test names start with the lower-cased case ID.

| Task | Test file | Case | Covered in Phase 1 | Completed by |
|---|---|---|---|---|
| MER-10 | config.rs | CFG-01 | Fully | |
| | | CFG-02 | Fully | |
| | | CFG-03 | Fully | |
| | | CFG-04 | Creator/settler/admin cross-checks on create, add_strike, pause, update_config; distinct keys at init and update | `record_close` and `admin_settle` role checks: MER-31, MER-33 |
| | | CFG-05 | Fully (unknown, duplicate, lowercase, >7, empty) | |
| | | CFG-07 | Fully, plus in-range round-trip | |
| | | SEC-05 | Init bound to the upgrade authority; ProgramData read | Squads multisig as authority on devnet: MER-80 deploy script |
| MER-11 | ticker_day.rs | CAL-02 | Half-day close stored; minting stops at 13:00 ET | Order halt at 13:00: MER-20. Settler targets 13:00: MER-44 |
| | | CAL-06 | Fully | |
| | | MNT-12 | Fully | |
| MER-12 | create_market.rs | MKT-01 | Fully (book is a header account until MER-20) | |
| | | MKT-02 | Fully | |
| | | MKT-04 | Fully | |
| | | MKT-07 | Fully | |
| | | MKT-08 | Fully (IDL inspection) | |
| | | STK-08 | Fully | |
| MER-13 | mint_merge.rs | MNT-01 to MNT-08, MNT-10 | Fully | |
| | | MNT-05 | Mint at 08:45 | `place_order` before open fails: MER-20 |
| | | MNT-09 | Market forced to SETTLED / VOID | Real `settle_market`: MER-32 |
| MER-14 | invariants_prop.rs | INV-01, 02, 04, 06, 07, 08 | 10,000 random sequences of mint, merge, donate, pause, clock, transfer across 3 users and 2 markets; success/failure of every mint and merge is predicted and checked | Each later instruction joins the generator (MER-20 to MER-35) |
| | | INV-03 | Checker verified on settled/void snapshots | Exercised by real settlement: MER-32, MER-34 |
| | | INV-05 | | Book escrow: MER-20, MER-21 |
| | | INV-09 | Fully for mint/merge | Huge orders: MER-20 |
| | | MNT-11 | Fully | |
| | | SET-11 | Payout table sums to $1.00 for every outcome | Random (price, expo, strike) comparison: MER-30 |
| | | CON-09 | Config and TickerDay read-only on mint/merge; no shared writable account across markets | place, buy_no, sell_no, redeem: as they land |
| | | CON-02 to CON-06, CON-08 | | Need the order book and settlement: MER-20 to MER-34 |
| MER-15 | pause.rs | PSE-01 | Mint blocked, `Paused` emitted | `place_order`, `buy_no_*`, `sell_no`: MER-20 to MER-24 |
| | | PSE-02 | `merge_pair` while paused | `cancel_order`, `withdraw`: MER-21 |
| | | PSE-03 | Market creation while paused | `record_close`, `settle_market`, `redeem`, `prune_orders`: MER-31 to MER-35 |
| | | PSE-04 | Mint restored | `place_order` restored: MER-20 |
| | | PSE-05 | Fully | |

## Phase 0 items built along the way

Phase 1 needed part of Phase 0, so this PR also includes:

- MER-01 (partial): workspace, `Makefile` with `doctor` / `build` / `test`, `.env.example`, README quick start. `make dev` and the services layout come with Phase 4.
- MER-02 (partial): all spec 4.1 accounts and all spec 4.6 events are declared, and the IDL is committed with a drift check. Later-phase instructions are added in their own tasks rather than stubbed now. `packages/sdk` TypeScript generation comes with MER-05.
- MER-06 (partial): a CI workflow for the program (build, IDL drift, no untracked `#[ignore]`, tests). Path-scope and boundary lint come with MER-06 proper.

## Choices made where the spec was silent

- `OrderBook` is created now as a small header PDA (market, next_order_id, order_count). MER-20 defines price-level storage and grows or replaces it; that is a contract change in Phase 2.
- `Paused` / `Unpaused` events put the Config address in `market` and `seq = 0`, since they are not about one market.
- `update_config` bounds: `fee_bps <= 1000`, `0 < settle_window_s <= 300`, `0 < override_delay_s <= 7 days`, bps fields in `1..=10000`, `0 < dispute_window_s <= 1 day`, `0 < dispute_resolution_s <= 30 days`, `dispute_bond > 0`.
- `add_strike` has a separate `payer` signer so the multisig does not pay rent; the automation wallet can.
