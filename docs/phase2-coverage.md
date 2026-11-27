# Phase 2 coverage (MER-20 to MER-25)

Order book built into the program (D7), the four trade paths on one book, halt at close,
cancel and withdraw, and the taker fee. Test names start with the lower-cased case ID.

## Phoenix-fallback checkpoint (D7)

The checkpoint asks whether the four trade paths and the halt-at-close tests are green at
the end of Phase 2. They are, so the plan stays on our own book and the Phoenix fallback
(spec 4.5) is not triggered.

| Checkpoint item | Tests |
|---|---|
| Buy Yes / Sell Yes (`place_order`) | TRD-01, 02, 03, 09, 10, 15 |
| Buy No market (`buy_no_market`) | TRD-04, 05, 06 |
| Buy No limit (`buy_no_limit`) | TRD-07, 08 |
| Sell No (`sell_no`) | TRD-11, 12, 13, 14 |
| Halt at close | HLT-01, HLT-02, HLT-03, CAL-02 (13:00 half day), CAL-09, CON-04 |
| Book invariants under random sequences | INV-05 and the property test (10,000 sequences) |

## Matrix coverage

| Task | Test file | Case | Covered in Phase 2 | Completed by |
|---|---|---|---|---|
| MER-20 | clob_place_order.rs | BOOK-01 to BOOK-09 | Fully | |
| | | BOOK-13 | Fully (rule: cancel the resting order, see below) | |
| | | BOOK-14 | Fully (8 orders per level) | |
| | | BOOK-15, MNT-05 (order half) | Fully | |
| | | HLT-01, HLT-02 | Fully, all four paths | |
| | | CAL-02 (order half) | Order at 13:00:00 on a half day rejected | Settler targets 13:00: MER-44 |
| | | CAL-09 | Order half (chain clock decides) | `record_close` half: MER-31 |
| | | TRD-01, 02, 03, 09, 10, 15 | Fully | |
| | | TRD-17 | 20-level Buy No: 1,084 bytes with a lookup table, 283,926 CU of a 400,000 budget (29% headroom, including creating two token accounts) | |
| | | SEC-01 (order half) | Another market's book, base vault, quote vault or vault rejected | `redeem` half: MER-34 |
| | | SEC-09 | Fully | |
| | | INV-09 (order half) | Orders above `MAX_ORDER_QTY` rejected with `OrderTooLarge` | |
| MER-21 | clob_cancel_withdraw.rs | BOOK-10, 11, 12 | Fully | |
| | | HLT-03 | Fully | |
| | | SEC-03 | Fully | |
| MER-22 | buy_no_market.rs | TRD-04, 05, 06 | Fully | |
| MER-23 | buy_no_limit.rs | TRD-07, TRD-08 | Fully, plus cancel with no fill and cancel after the No was moved | Prune after close merges a BUY_NO order: MER-35 (CLN-02) |
| MER-24 | sell_no.rs | TRD-11, 12, 13 | Fully | |
| | | TRD-14 (program half) | Resting Yes bid, then withdraw + `merge_pair` in one transaction | Tx Builder mapping: MER-62 |
| MER-25 | fees.rs | CFG-06 | Fully (fee accrues per market, `sweep_fees` moves it to the fee vault) | |
| MER-14 | invariants_prop.rs | INV-05 | Every step of every random sequence | |
| | | INV-01, 02, 04, 06, 07, 08 | Generator now includes place (GTC, IOC, POST_ONLY), cancel, cancel_all, Buy No market and limit, Sell No and withdraw with a 25 bps fee | settle, redeem, prune: MER-30 to MER-35 |
| | | CON-02, 03, 04, 08 | Fully | |
| | | CON-09 | Config and TickerDay read-only on all four trade paths; different markets share no writable account | `redeem`: MER-34 |
| | | MNT-11 | Only `mint_pair` and `buy_no_*` mint | |
| MER-15 | pause.rs | PSE-01, PSE-02, PSE-04 (order halves) | Fully | PSE-03 settle/redeem/prune: MER-31 to MER-35 |

Still open from Phase 1 and now done: MNT-05 order half, CAL-02 order half, INV-05, INV-09
huge orders, PSE-01/02/04 order halves, CON-02 to CON-04, CON-08, CON-09 for trade paths.

Not program cases (later phases): TRD-16 and HLT-04 (API), HLT-05 (frontend), POS-* (Tx
Builder and UI), SCL-06 (load harness, MER-83).

### Amounts in the matrix

Some matrix rows quote notionals a factor of 10 too low for D24 (10,000 micro-USDC per
cent). For example BOOK-03 says 10 contracts at 55 cents cost 550,000 micro-USDC; under
D24 that is 5,500,000 ($5.50). The same applies to TRD-01, TRD-04, TRD-05, TRD-08, BOOK-09
and CFG-06 (fee 60,000, not 6,000). The tests follow D24. Rows quoted in whole dollars
(for example "alice +6,000,000" in TRD-08) are already right.

## Contract changes in this PR

These change the IDL (regenerated and drift-checked) and the indexer's contract:

- `OrderBook` is now zero-copy: 99 levels × 2 sides × 8 orders, with `base_vault`,
  `quote_vault`, `next_order_id`, running totals of every ledger's locked and free
  balances, and `fees_accrued`. 90,456 bytes, about 0.63 SOL of rent, reclaimed by
  `close_book` (MER-35).
- `create_strike_market` / `add_strike` take two more accounts (`base_vault`,
  `quote_vault`) and create the book at 10 KiB; new permissionless `grow_book` grows it
  10 KiB at a time (the per-instruction limit). The morning job sends
  `create_strike_market` + 8 × `grow_book` in one transaction; re-running it is a no-op.
- New instructions: `grow_book`, `place_order`, `buy_no_market`, `buy_no_limit`,
  `sell_no`, `cancel_order`, `cancel_all`, `withdraw`, `sweep_fees`.
- Events: `OrderPlaced` gains `client_id`; `OrderCancelled` gains `owner`, `side`,
  `price`, `qty` (so the indexer can update the book from the event alone); new
  `CancelReason::SelfTrade`; new `FeesSwept` event.
- New errors: `MarketNotOpen`, `MarketHalted`, `InvalidPrice`, `OrderTooLarge`,
  `LevelFull`, `WouldCross`, `NoLiquidity`, `OrderNotFound`, `MakerLedgerMissing`,
  `InsufficientFunds`. A trade on a book that has not been fully grown fails Anchor's
  account check (the book has no discriminator until `grow_book` finishes).

## Choices made where the spec was silent

- **Maker ledgers are remaining accounts.** A maker does not sign the taker's
  transaction, so the taker (the Tx Builder) passes each crossing maker's `UserLedger`.
  Matching stops at the first maker whose ledger is missing, so price-time priority is
  never skipped; an IOC remainder is dropped, and a GTC remainder that would rest
  crossed fails with `MakerLedgerMissing`. Ledgers from another market are ignored.
- **Self-trade:** the taker's own resting order is cancelled (unlocked to its ledger)
  and matching continues. No fill and no fee against oneself. A self-cancelled BUY_NO
  ask unlocks its Yes to the ledger rather than merging, because `place_order` does not
  carry the No accounts; the user can withdraw and merge.
- **Fees accrue per market.** The taker fee is charged per fill, rounded up, and held in
  the market's quote vault (`fees_accrued`); permissionless `sweep_fees` moves it to
  `Config.fee_vault`. Paying the shared fee vault inside every trade would make every
  market's trades write one account, which breaks CON-09 and serialises trading across
  markets. The fee never touches the collateral vault.
- **Book escrow invariant is stronger than spec 4.3 #7:** the vaults must cover free
  balances and accrued fees as well as locks (`base ≥ locked_yes + free_yes`,
  `quote ≥ locked_usdc + free_usdc + fees_accrued`), because maker proceeds wait in the
  book vaults until withdrawn.
- **Buy No limit that crosses** fills immediately at the bids' prices, then rests the rest.
- **Sell No with nothing to buy** under the worst price succeeds and changes nothing
  (IOC semantics); Buy No market with nothing to sell fails with `NoLiquidity` (DoD).
- **BUY_NO cancel when the No has moved:** only the No still held is merged; the rest of
  the unfilled Yes stays in the ledger as free Yes. After settlement the cancel only
  unlocks; the conversion belongs to `prune_orders` (MER-35).
- **On-chain order ceiling `MAX_ORDER_QTY = 1,000,000`.** The 500-contract product cap
  (D6) stays in the Tx Builder; this bound keeps all notionals far from overflow.
- **Events are emitted through a reusable buffer** (`Emitter`) instead of `emit_cpi!`.
  The wire format is identical; `emit_cpi!` allocates per event and a 20-maker sweep ran
  out of the program's 32 KiB heap.
- **Account count:** the trade instructions share one account list of 19 fixed accounts
  (the user's ledger and token accounts are created on first use), plus one ledger per
  maker crossed. The DoD's "≤ 12 accounts" is not met literally; what it protects, the
  1,232-byte limit, is met with a lookup table (TRD-17).
