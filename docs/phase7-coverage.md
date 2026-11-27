# Phase 7 coverage (MER-70 to MER-76)

The trader frontend (`app/`, component C11): Next.js 15 static export, React 19, Solana wallet
adapter (Phantom, Solflare, plus any Wallet Standard wallet such as Backpack). It talks only to the
Phase 6 public tier: REST API (`/v1/*`), Tx Builder (`/v1/tx/*`, unsigned v0 transactions the
wallet signs) and the WebSocket gateway (`book`, `trades`, `mkt`, `px`, `user`, `sys`). Devnet RPC
is used only to send signed transactions, check their status, read the USDC balance and check the
genesis hash.

Component tests: Vitest + jsdom + Testing Library, 79 tests (~6 s). End-to-end: Playwright
(Chromium), 17 tests (~40 s). Screenshots of every page are in `docs/phase7-screenshots/`.

```
make app-dev    # stub backend on :8787 and the Next dev server on :3000
make app-test   # typecheck, component tests, static build, Playwright
```

## Matrix coverage

| Task | Test file | Cases |
|---|---|---|
| MER-70 wallet, SIWS, network guard | `app/__tests__/WalletConnect.test.tsx` | FE-01, FE-03 (SIWS half) |
| MER-71 landing, markets | `app/__tests__/MarketsPage.test.tsx` | FE-05, FE-10 |
| MER-72 order book | `app/__tests__/OrderBook.test.tsx` | FE-04 |
| MER-73 trade panel | `app/__tests__/TradePanel.test.tsx` | FE-02, FE-03, FE-06, FE-09, POS-04, POS-07, HLT-05, PSE-06 |
| MER-74 portfolio | `app/__tests__/Portfolio.test.tsx` | FE-07, FE-08, FE-11, POS-05 |
| MER-75 history, countdown | `app/__tests__/HistoryCountdown.test.tsx` | FE-12, CAL-08 |
| MER-76 end-to-end | `app/e2e/frontend.spec.ts` | FE-01 to FE-13, POS-04, POS-07, HLT-05, PSE-06 |

## Deviation: e2e runs against a stub backend, not `make dev`

MER-76 asks for Playwright against `make dev` with a local validator. There is no `make dev` yet,
and the Phase 6 services need Postgres, Redis, the Indexer and a validator running together, which
is Phase 8 work. Instead `app/dev/stub-server.ts` serves the same REST, Tx Builder and gateway
protocol from fixtures, and reuses `services/shared` for the SIWS message, ed25519 check, JWT,
summary copy, No view and fee math, so those can't drift from Phase 6. It verifies the real
ed25519 signatures the test wallet produces on SIWS messages and transactions, and it has control
routes (`/__stub/reset`, `/__stub/settle`, `/__stub/pause`, ...) that the specs use to move the day
through its phases. The test wallet (`app/e2e/test-wallet.ts`) is a Wallet Standard wallet whose
keys live in the Playwright process.

What this does not prove: that the real Tx Builder's transactions execute (Phase 6's LiteSVM suites
do), or that the services agree with the stub under load. Pointing the e2e suite at real services is
one env change (`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`, `NEXT_PUBLIC_RPC_URL`) once a dev
stack exists.

## Choices worth reviewing

- **SIWS on the first user-scoped action**, not on connect: browsing markets never asks for a
  signature. Portfolio, history and trading prompt once. The JWT is kept per wallet in
  `sessionStorage` and its expiry is compared on the server clock (the client clock can be skewed);
  an account switch re-authenticates.
- **Countdown and close checks use the `serverTime` offset** from `/v1/status`. The trade panel stays
  open until `close_time` on the server clock even when the client clock is past it.
- **Redeem may return several transactions.** The Tx Builder packs up to 50 markets into as few
  transactions as fit; the frontend signs each. Losing tokens show $0.00 with a **Clear** button
  (a redeem that burns them for nothing), so they leave the portfolio.
- **USDC balance comes from RPC**, because the `md:bal` feed isn't wired yet. It refreshes after every
  confirmed transaction.
- **Underlying price shows its publish time and a Stale tag after 60 s**, because the `md:px` feed
  isn't wired; until it is, cards show the last REST value.
- **Market orders send a worst price** of best ± slippage (prefs, default 2¢), clamped to 1–99.
- **A pending Buy No shows at $1.00 entry** until it fills, matching the Phase 5 position model.
- **Builder refusals (409) map to one action**: Sell No first, Sell Yes first, Cancel the Buy No, or
  reduce quantity. Nothing is sent to the wallet.

Still open from the matrix: load (SCL-*, Phase 8) and the e2e run against real services.
