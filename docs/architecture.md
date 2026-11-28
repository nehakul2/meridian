# Architecture rationale

Why Meridian is built the way it is, what the alternatives were, and what each major
dependency is for. The structural contracts (accounts, events, schema, Redis keys, routes)
are fixed in the architecture spec in the project files; this note records the reasoning
behind the choices the code now depends on. Limits and open items are in
[risks.md](risks.md) and [open-questions.md](open-questions.md).

## Shape of the system

```
wallet ──signs──▶ Solana program (markets, book, settlement)
   ▲                    │ events (emit_cpi)
   │                    ▼
Tx Builder ◀── Redis read model ◀── Indexer ──▶ md:events stream ──▶ PG Writer ──▶ Postgres
REST API  ◀──┘        ▲                                              (history, reconcile)
WS gateway ◀─────────┘
Automation (morning, settler, cranks) ──▶ program        Monitor ──▶ alerts, on-call
```

The chain is the only source of truth for money. Every off-chain component is a projection
of chain events or a builder of unsigned transactions; none holds user funds or keys, and no
request path reads RPC.

## Chain: Solana (A1)

- **Cost and speed per trade.** A binary market with 1¢ ticks needs cheap order placement and
  cancels; fees well under a cent and ~400 ms slots make a fully on-chain book practical.
- **SPL tokens for Yes and No.** Positions are ordinary tokens in the user's wallet, so
  "non-custodial" holds for positions, and any wallet shows them.
- **Pyth pull oracle with verified historical updates.** The settlement design (below) needs
  a signed price for a specific past second; Pyth's receiver verifies such updates on Solana.
- **Trade-off:** a 1,232-byte transaction limit and per-instruction compute and heap limits.
  They shape the program: lookup tables for Buy No, a fixed 99-level book, eight orders per
  level, and a 32-fill cap per trade (found by the load harness, [phase8-coverage.md](phase8-coverage.md)).

Alternatives considered: an EVM L2 (cheaper to audit with mature tooling, but per-order gas
makes a resting-order book costly and the oracle story for "price at a past second" is weaker),
and an off-chain matcher with on-chain settlement (fast, but the operator then controls
ordering and the halt at the close, which is the property users most need to trust).

## Order book: in the program, not Phoenix (D7, A3)

The deciding requirement is **no trade after `close_time`** (R3.1). Our own book checks the
chain clock inside every trade instruction, so nothing can fill after the close. With Phoenix we
would need a pause transaction at 16:00 and any order landing first would still trade on a known
outcome. Owning the book also gives atomic Buy No with exact partial fills, merge-on-cancel,
force-cancel and pruning after settlement, and closing the book account to reclaim its rent
every evening.

Costs accepted: more code holding funds (a larger audit), and our own matching limits. The
book is kept simple on purpose: 99 fixed price levels per side, a ring of eight orders per
level, makers paid into a per-market ledger. The Phase 2 checkpoint (trade paths and halt tests
green) passed, so the Phoenix fallback in spec 4.5 was not needed.

## Oracle: Pyth as the on-chain cross-check (D13, A2)

- The settlement price is the **official closing-auction price** (D3), which Pyth does not
  publish as such. The settler fetches it from two vendors (Massive primary, Databento second)
  and writes it only if they agree.
- The program accepts that write only next to a **fully verified Pyth update stamped in
  `[close_time, close_time + ε]`** with `conf/price ≤ 10 bps`, and only if the official close is
  within `max(conf, 20 bps)` of it. A compromised settler key cannot record an arbitrary price.
- Why Pyth: equity feeds for all MAG7 tickers, sub-second publishing, and a receiver program
  that verifies the Wormhole signatures on-chain. Hermes serves historical updates by timestamp,
  which the settler and the devnet lifecycle use.
- Implied volatility (Massive) is used only for strike spacing and display, never in settlement.

## Settlement: one close per ticker-day, timestamped at the close (D1, D2, D8, D10, D11)

- **Close-timestamped, not "latest".** The price used is the one stamped at `close_time`; retries
  resubmit that same update and never fetch a newer one (D2). Settlement therefore does not
  depend on when the job runs.
- **One locked price per (ticker, date).** `record_close` writes it once to the `TickerDay`; every
  strike of that ticker settles from it, so strikes cannot be settled inconsistently.
- **Provisional for 20 minutes.** Anyone can dispute with a 100 USDC bond; the multisig upholds or
  corrects once (D8). Strikes settle only from a final price; `settle_market` is permissionless
  because it only copies that price.
- **Fallbacks.** If nothing is recorded by close + 30 min, the multisig override opens (D4) and
  goes through the same window. A strike inside the confidence band goes to the multisig (D27).

## Off-chain tier

- **Indexer → Redis read model → API / WS.** Reads are served from Redis (p99 < 20 ms budget), so
  the API scales horizontally and never touches RPC. Every event carries `market`, `slot` and `seq`,
  which lets the gateway send gap-free deltas and the PG Writer detect gaps and reorgs.
- **Tx Builder returns unsigned transactions.** The user's wallet signs; the server enforces
  position guards and caps for UX but the program enforces the money rules.
- **Automation** runs the daily lifecycle with its own RPC and hot keys (market creator, settler,
  fee payer) that cannot override, pause or upgrade (D23).
- **Monitor** turns PRD liveness targets into alerts (morning by 08:45, close recorded by close +
  5 / 15 min, strikes settled 10 min after the price is final, indexer lag, gateway errors,
  invariant breaks), deduplicated per (code, symbol, date).

## Dependencies and why each is here

| Dependency | Where | Why this one |
|---|---|---|
| Anchor 0.31.1 (`anchor-lang`, `anchor-spl`) | program | Account validation, PDA seeds and the IDL from one source; `emit_cpi!` events survive log truncation. Pinned to match the IDL and the TypeScript client |
| `bytemuck` | program | Zero-copy layout for the ~90 KB order book, which cannot be deserialised on every trade |
| Agave 2.3.13 (Solana CLI, platform-tools v1.48) | build | Pinned toolchain for reproducible `.so` builds; `make doctor` checks it |
| LiteSVM (Rust 0.6, Node 0.8) | tests | Runs the real program in-process in milliseconds; every program, Tx Builder, devnet-script and load test executes against it |
| `@coral-xyz/anchor`, `@solana/web3.js` 1.x, `bn.js` | services | IDL-driven encoding and decoding shared with the program; web3.js 1.x is what Anchor and the wallet adapter use |
| `@pythnetwork/pyth-solana-receiver` | automation, scripts | Builds the post-and-verify instructions for Pyth updates; writing them by hand would duplicate Wormhole verification logic |
| `fastify` 5 | API, Tx Builder | Fast JSON routing with schema hooks; measured server p99 well inside the 20 ms / 30 ms budgets |
| `ws` | WS gateway | Plain, widely used WebSocket server; `uWebSockets.js` is not published to npm |
| `ioredis` | all services | Pipelines, streams and pub/sub in one client; Redis holds the read model and the event stream |
| `pg` | automation, PG Writer, API, monitor | Postgres for history, reconcile reports, job runs and alerts; plain SQL, no ORM, so migrations stay the contract |
| Next.js 15, React 19, Solana wallet adapter | app | Static export served from a CDN; the wallet adapter supports Phantom, Solflare and Wallet Standard wallets |
| Vitest, Playwright | tests | One test runner across services; Playwright drives the frontend end to end |

Every dependency is pinned by lockfile. Platform-tools ships Cargo 1.84, so the Rust lockfile
is resolved with the fallback resolver and two crate pins (README "Dependency pins").
