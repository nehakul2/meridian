# Open questions and the defaults built

Every product question in spec section 12 has been decided (D3 to D8, D15). What remains open
is listed here with the behaviour the code has today, so each can be changed without hunting.
Most defaults are `Config` fields the admin multisig can change with `update_config`, or
service environment variables in `.env.example`.

## Settlement

| Question | Default built | Where to change it |
|---|---|---|
| Do Massive and Databento report the same official close, and how fast? (MER-48 spike) | Two-vendor agreement required; Databento `XNAS.ITCH` statistic 11; Massive at `api.massive.com` | Run `scripts/close-spike.ts` for five trading days with `MASSIVE_API_KEY` and `DATABENTO_API_KEY`; vendor settings in `.env.example` |
| How close must the official close be to Pyth? | `max(conf, 20 bps)` | `Config.close_tolerance_bps` |
| How wide is the window for the Pyth update after the close? | ε = 5 s | `Config.settle_window_s` |
| Maximum Pyth confidence at the close | 10 bps (D27) | `Config.conf_bps_max` |
| Dispute window and bond | 20 minutes, 100 USDC (D8); 60 s on devnet | `Config.dispute_window_s`, `Config.dispute_bond`; devnet: `scripts/devnet/deploy.ts` `DevnetSettings` |
| Admin override delay | 30 minutes (D4) | `Config.override_delay_s` |
| Which source records the close on devnet? | The Pyth price at the close, attested by the settler key, because the vendor feeds are not wired there | `scripts/devnet/lifecycle.ts` |

## Markets and trading

| Question | Default built | Where to change it |
|---|---|---|
| Strike spacing | Dynamic (D5): a ladder of 0.50, 1, 2.50, 5, 10, 25 and 50 dollars chosen from price and implied volatility, ATM from the prior close | `services/automation/src/strikes.ts` policy |
| Per-trade cap | 500 contracts (D6), enforced by the Tx Builder; the program's own limit is 1,000,000 | `max_qty_per_trade` in the read-model config (`md:cfg`, default in `services/indexer/src/projector.ts`) |
| Fills per trade | 32 resting orders; market orders stop there, limit orders that would still cross are refused | `MAX_FILLS_PER_IX` in `programs/meridian/src/constants.rs` (bounded by the event heap, about 50) |
| Orders per price level | 8 | `LEVEL_CAPACITY` in the program (changes the book size and rent) |
| Taker fee | 0 bps on devnet (D28) | `Config.fee_bps` |

## Operations

| Question | Default built | Where to change it |
|---|---|---|
| How many API instances serve 2,000 req/s? | 4 assumed; the load harness measures one at 500 req/s | `API_INSTANCES` for the nightly load run |
| "Strikes unsettled" alert: from the close or from the final price? | 10 minutes after the price is final, because strikes cannot settle during the dispute window (D8) | `services/monitor/src/rules.ts` thresholds |
| Who is paged? | The webhook in `ONCALL_WEBHOOK_URL` (Slack-style) | Monitor environment |
| Devnet program id | The id in the committed IDL; deploying it needs its keypair. `scripts/devnet/set-program-id.sh` switches to a new keypair | See README "Devnet" |

## Not built yet

- **`make dev`** (MER-01) does not exist. The frontend e2e suite runs against a stub backend; the
  load harness runs the real Indexer, PG Writer, API, Tx Builder and gateway together in one
  process against the program on LiteSVM.
- **Feeds for `md:bal` and `md:px`** and an Automation consumer for admin job reruns
  (`md:jobreq`) are not wired (Phase 6).
- **Pyth feed ids** for the seven tickers are not seeded in `tickers.pyth_feed_id`. The devnet
  scripts look them up from Hermes by symbol (`Equity.US.<SYM>/USD`).
- **AST-08** (assistant load) waits for the trading assistant in Phase 10.
