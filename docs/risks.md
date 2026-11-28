# Risks and limitations

Technical and operational risks of the system as built. This note covers only how the
software behaves and where trust is placed. It follows spec section 11 and adds what building
and load testing showed.

## Trust in roles

- **Admin powers are a trust assumption.** The admin (a Squads multisig) can override a close
  after the 30-minute delay, resolve disputes, pause entry, change configuration and upgrade
  the program. "Non-custodial" means users hold their own tokens and USDC; it does not mean
  there is no admin (R5.8).
- **Hot keys live on servers.** The market creator and settler keys can create markets and
  record a close inside the ε window next to a matching Pyth update, but cannot override,
  pause or upgrade. A stolen settler key can at most record a close within the Pyth bound,
  which the dispute window can still correct.

## Oracle and settlement

- **Finality after 20 minutes.** A wrong but valid print can be disputed for 20 minutes (D8);
  after that it is final. A correction is a multisig decision.
- **The admin override price has no on-chain bound** in v1 (D19, A22); the dispute window is the
  only on-chain guardrail.
- **Close-price semantics depend on vendors and the oracle feed.** The official close comes from
  two vendors that must agree, cross-checked against Pyth at the close. If they disagree, or Pyth
  has no tight update in `[close_time, close_time + 5 s]`, nothing is recorded automatically and
  the manual path opens at close + 30 min.
- **Pyth equity feeds publish only during US market hours.** Settlement and the devnet lifecycle
  depend on an update stamped at the close.

## Trading

- **The order book is new code holding funds.** It is less battle-tested than an established
  CLOB. It has property tests over thousands of random sequences and invariant checks at the end
  of every mutating instruction, and it should be the top audit priority.
- **At most 32 fills per trade.** Anchor's event heap limits one instruction to about 50 fills,
  so the program caps a trade at 32 resting orders. A market order stops there with a partial
  fill; a limit order that would still cross afterwards is refused, and the Tx Builder refuses
  it first with a clear message. Very large sweeps need several trades.
- **Eight orders per price level.** A full level rejects new orders at that price.
- **"Can't hold both Yes and No" is enforced by the app and API only** (D16, A10). A user who
  builds transactions directly can hold both; the payout rules still hold.

## Operations and scale

- **State growth.** Mints, market and vault accounts persist forever so redeem always works (D29).
  The load harness measured about 0.59 SOL of rent left per trading day of 49 markets after the
  books close (about 147 SOL over 250 trading days). Book rent (about 31 SOL a day) is returned
  every evening.
- **Working capital.** The automation wallet fronts about 0.64 SOL of rent per market each
  morning (about 31.5 SOL for 49 markets) until the books close.
- **Read capacity per instance.** One API instance served 500 req/s at a 11 ms server p99 in the
  load harness, with the whole stack in one process. The 2,000 req/s target assumes about four
  API instances behind a load balancer; this has not been measured on deployed infrastructure.
- **Liveness depends on automation.** The morning run, settler and cranks are scheduled jobs.
  The monitor pages if the morning is incomplete at 08:45 ET, the close is not recorded by close
  + 15 min, or strikes are not settled 10 minutes after the price is final. Settlement and redeem
  stay permissionless, so anyone can complete them if automation stops.

## Devnet

- Devnet uses a test USDC mint created by the deploy script, a 60-second dispute window and zero
  fees, so the full lifecycle fits in one run. On devnet the official close is taken as the Pyth
  price at the close, because the vendor feeds are not wired there.
- Devnet itself can be slow, reset or rate-limited; the release smoke rolls back to the previous
  binary and opens an issue when the lifecycle fails.
