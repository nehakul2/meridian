# Phase 3 coverage (MER-30 to MER-37)

Settlement, redemption and cleanup: the official close recorded with the Pyth cross-check
(D3, D13), the admin override (D4), the dispute window (D8), per-strike settlement with
the confidence-band refusal (D27), redeem and void (D20), prune with the BUY_NO
conversion (D15) and closing the book (D29). Test names start with the lower-cased case
ID. 91 new tests. `lifecycle.rs` runs in under a second; the whole suite with 10,000
property sequences took 3 min 53 s here (the property test alone 3 min 37 s, since one
sequence in four now also settles and redeems).

## Matrix coverage

| Task | Test file | Case | Covered in Phase 3 | Completed by |
|---|---|---|---|---|
| MER-30 | price_compare.rs | SET-03, SET-04 | Fully, at expo −2, −5, −7, −8, 0, −1 and +2, one unit either side, `i64::MAX` at every allowed exponent | |
| | | ORC-14 | Comparison half | Instruction half: record_close.rs |
| | | SET-11 | 10,000 random (price, expo, strike), cross-checked against independent integer math | |
| MER-31 | record_close.rs | ORC-01 to ORC-16, ORC-19 | Fully | |
| | | SEC-02 | Fully (wrong owner, and right owner with a wrong discriminator) | |
| | | CAL-09 | `record_close` half: chain clock decides | |
| | | (DoD) retry safety | A failed submission changes nothing; the same update then records the same values | |
| MER-32 | settle_market.rs | SET-01 to SET-10 | Fully | |
| MER-33 | admin_settle.rs | ADM-01 to ADM-05 | Fully (ADM-04 both landing orders) | |
| | | ADM-07 | Fully, with the design below. **Needs Neha's confirmation** | |
| | | CON-06 | As ADM-04 | |
| MER-34 | redeem_void.rs | RED-01 to RED-08 | Fully | |
| | | SEC-04, SEC-01 (redeem half) | Fully | |
| | | POS-08 | Program half: transferred tokens merge and redeem | Portfolio UI: Phase 7 |
| | | CON-09 (redeem) | Config read-only; redeems on different markets share no writable account | |
| MER-35 | prune_close_book.rs | CLN-01 to CLN-06 | Fully; CLN-03 prunes 50 orders in 343,345 CU | |
| MER-36 | lifecycle.rs | E2E-02, E2E-03, E2E-04 | Program half, each ending with accounted = 0 and USDC conserved to the micro-unit | Services and devnet: Phases 4 to 7 |
| | | (DoD) full lifecycle | create → mint → trade → halt → record → finalize → settle → prune → close_book → redeem | |
| MER-37 | dispute.rs | DSP-01 to DSP-07 | Fully | DSP-08 (Settlement Triage agent): Phase 9 |
| MER-15 | pause.rs | PSE-03 | Fully: record, finalize, settle, prune, close_book, withdraw, redeem while paused | |
| MER-14 | invariants_prop.rs | CON-05 | Fully (both landing orders) | |
| | | INV-01 to INV-08 | One random sequence in four now ends with the whole settlement path and checks that no claim is left, the vault holds only donations and USDC is conserved | |

Not program cases (later phases): ORC-17, ORC-18, SJ-* and CLN-07 (automation, Phase 4),
ADM-06 and RED-09 to RED-11 (API, Phase 6), E2E-01, E2E-05 to E2E-07 (devnet).

The tests follow D24 (10,000 micro-USDC per cent). The Phase 3 rows of the matrix quote
amounts in whole dollars or micro-USDC per contract, which already agree with D24.

## Contract changes in this PR

These change the IDL (regenerated) and the indexer's contract:

- New instructions: `record_close`, `admin_settle`, `raise_dispute`, `resolve_dispute`,
  `finalize_close`, `settle_market`, `admin_settle_market`, `void_market`, `redeem`,
  `prune_orders`, `close_book`.
- New account `Dispute` (`["dispute", ticker_day]`): disputer, bond taken, `raised_at`,
  evidence hash. `init` on it is what makes a second dispute fail.
- `TickerDay` gains `finalized_at` (D18: the on-chain final time, kept apart from the
  provisional `recorded_at`).
- `Config.bond_vault` must be a USDC token account owned by the PDA `["bond"]`, so the
  program can return or forward a bond. `raise_dispute` refuses any other vault.
- `withdraw`'s `book` account is now unchecked (same address, still writable), so it keeps
  working after `close_book` removes the book (CLN-06).
- `buy_no_limit` now also approves the Market PDA as delegate on the user's No account,
  for the user's unfilled BUY_NO quantity (see "BUY_NO conversion at prune").
- Ticker-day events (`CloseRecorded`, `DisputeRaised`, `DisputeResolved`,
  `CloseFinalized`) carry the TickerDay address in `market` and `seq = 0`.
  `resolve_dispute` emits `CloseFinalized` as well as `DisputeResolved`, so the strike
  crank has one trigger for every path to FINAL.
- New errors are appended after the Phase 2 ones, so existing codes do not move.

## Choices made where the spec was silent

- **Status names.** The matrix's RECORDED and OVERRIDDEN are both PROVISIONAL on-chain,
  told apart by `close_source` (ATTESTED_CHECKED, ORACLE_OFFICIAL or ADMIN): every price
  goes through the dispute window (D8).
- **Pyth update read by hand.** `record_close` checks that the account is owned by the
  Pyth Receiver program, has the `PriceUpdateV2` discriminator and
  `verification_level = Full`, then reads feed id, price, conf, exponent and
  publish_time. The receiver SDK is not pulled in because it does not build with the
  pinned platform-tools Cargo.
- **Official close format.** `record_close(official: Option<{price, expo}>)`. In
  ATTESTED_CHECKED mode it is required and its exponent must equal the reference
  update's (the settler converts NOCP to the feed's exponent, which is exact for cents),
  so the confidence check in `settle_market` compares like with like. In ORACLE_OFFICIAL
  mode the configured feed is the official-close feed, its price is recorded and an
  attested value is refused (ORC-19).
- **Tolerance is inclusive and exact**: accepted when
  `|official − ref| ≤ max(ref_conf, ref_price × close_tolerance_bps / 10,000)`, compared
  without division.
- **Band check scope.** `settle_market` refuses when `|price − strike| < ref_conf`.
  Prices set by the multisig (admin override, or a dispute correction) carry no band and
  skip the check.
- **A refused strike** returns `ConfidenceStraddle` and is left unsettled, so the crank
  sees the code and alerts. Trading is already halted by the chain clock; no separate
  HALTED status is written.
- **ADM-07, the admin path for a refused strike: `admin_settle_market(outcome)`.**
  Multisig only, only for a strike inside the band, only from a FINAL price. The
  multisig picks YES or NO from the exchange's official close; `settle_price` stays the
  ticker-day's price, so all strikes still share one price (D11). Void is not used
  here because voiding needs zero trades. The matrix asks to confirm this choice.
- **BUY_NO conversion at prune (D15).** Prune is permissionless, so it cannot burn the
  owner's No by the owner's signature. `buy_no_limit` therefore approves the Market PDA
  as delegate on the owner's No account for the unfilled BUY_NO quantity, and prune
  burns Yes + No through that allowance and credits $1.00 per pair to the owner's
  ledger. If the No account is not passed, the allowance was revoked, or the No was
  moved, the rest is unlocked as free Yes instead. No value is lost: Yes + No redeem for
  $1.00 together after settlement, or merge before it.
- **Prune order and bounds.** Bids then asks, 1 to 99 cents, oldest first; at most 64
  orders per call; pruning stops at the first order whose owner's ledger is not passed
  (so a cranker cannot skip anyone), and a call that prunes nothing while orders remain
  fails with `MakerLedgerMissing`.
- **Prune timing.** Allowed from `close_time`, before settlement too, as the MER-35 DoD
  and spec 4.2 say. D12's wording ("stays locked until the price is final") is stricter;
  releasing earlier gives owners their own funds back sooner and cannot change any
  outcome. Easy to tighten to "FINAL only" if preferred.
- **Rent from `close_book`** goes to `Config.market_creator`, the automation key that
  creates (and pays for) the books, since Config has no separate automation-wallet field.
  `close_book` also sweeps any accrued fees to the fee vault first.
- **Dispute refunds** go to any USDC account owned by the disputer; the resolution path
  checks the owner, not a fixed address.
- **`settle_market` on a VOID market** is a no-op success, like a repeat settle, so cranks
  never alert on it.
- **`void_market`** works while the market is trading or halted (zero fills only) and
  stops minting and trading at once.
- **Exponents** accepted anywhere a price is written are −18 to +10, which keeps every
  `i128` comparison far from overflow.
