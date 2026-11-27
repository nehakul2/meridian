-- MER-03 contract: the PostgreSQL schema from architecture-spec.md Section 5, verbatim.
-- Phase 4 is the first phase with services, so this migration lands here; Phase 5 owns the
-- chain-derived tables (PG Writer) and must not change them without a contract PR.
-- Write ownership: chain-derived tables = PG Writer; oracle_updates, job_runs, alerts =
-- Automation and Monitor; user_prefs = API; reference tables = migrations and admin tooling.

-- ===== Reference =====
CREATE TABLE tickers (
  symbol          TEXT PRIMARY KEY,               -- 'AAPL'
  pyth_feed_id    BYTEA NOT NULL UNIQUE,          -- 32 bytes
  liquidity_tier_override CHAR(1) CHECK (liquidity_tier_override IN ('A','B','C')), -- D5, optional
  enabled         BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE strike_policy (                      -- D5, one active row
  id              SERIAL PRIMARY KEY,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  step_ladder_cents INT[] NOT NULL DEFAULT '{50,100,250,500,1000,2500,5000}',
  min_step_bps    INT NOT NULL DEFAULT 25,         -- step never below 0.25% of price
  spacing_mult_bps JSONB NOT NULL DEFAULT '{"A":5000,"B":7500,"C":10000}', -- × 1-day move
  strikes_per_side JSONB NOT NULL DEFAULT '{"A":4,"B":3,"C":2}',
  max_per_side    INT NOT NULL DEFAULT 6,
  coverage_sigma_bps INT NOT NULL DEFAULT 20000,   -- outer strikes reach ≥ 2.0 × 1-day move
  iv_floor_bps    INT NOT NULL DEFAULT 1500,       -- 15%
  iv_ceiling_bps  INT NOT NULL DEFAULT 15000,      -- 150%
  rv_fallback_mult_bps INT NOT NULL DEFAULT 12000, -- RV20 × 1.2 when IV missing
  tier_a_min_contracts BIGINT NOT NULL DEFAULT 50000, -- trailing 5-day avg per day
  tier_b_min_contracts BIGINT NOT NULL DEFAULT 5000
);

CREATE TABLE strike_inputs (                      -- D5: frozen inputs, reproducible strikes
  symbol          TEXT NOT NULL REFERENCES tickers(symbol),
  trading_date    DATE NOT NULL,
  prev_close_cents BIGINT NOT NULL,               -- official close (D3)
  iv_bps          INT,                            -- ATM implied vol, nearest expiry
  iv_source       TEXT,                           -- 'MASSIVE' + snapshot time (D9)
  rv20_bps        INT NOT NULL,                   -- 20-day realized vol from official closes
  vol_used_bps    INT NOT NULL,
  vol_basis       TEXT NOT NULL CHECK (vol_basis IN ('IV','RV_FALLBACK')),
  liquidity_contracts_5d BIGINT NOT NULL,
  liquidity_tier  CHAR(1) NOT NULL,
  move_1d_cents   BIGINT NOT NULL,
  step_cents      INT NOT NULL,
  per_side        INT NOT NULL,
  strikes_cents   BIGINT[] NOT NULL,
  policy_id       INT NOT NULL REFERENCES strike_policy(id),
  computed_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (symbol, trading_date)
);

CREATE TABLE trading_calendar (
  trading_date    DATE PRIMARY KEY,               -- ET date
  open_time       TIMESTAMPTZ NOT NULL,
  close_time      TIMESTAMPTZ NOT NULL,           -- 16:00 or 13:00 ET, stored UTC
  is_half_day     BOOLEAN NOT NULL DEFAULT FALSE
);                                                -- holidays: no row

CREATE TABLE corporate_actions (
  symbol          TEXT REFERENCES tickers(symbol),
  effective_date  DATE NOT NULL,
  kind            TEXT NOT NULL,                  -- 'SPLIT','REVERSE_SPLIT','OTHER'
  skip_markets    BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (symbol, effective_date, kind)
);

-- ===== Chain-derived: markets =====
CREATE TABLE ticker_days (
  pda             TEXT PRIMARY KEY,               -- base58
  symbol          TEXT NOT NULL REFERENCES tickers(symbol),
  trading_date    DATE NOT NULL,
  prev_close_cents BIGINT,                        -- used for strike gen
  close_time      TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('OPEN','PROVISIONAL','DISPUTED','FINAL')),
  final_basis     TEXT CHECK (final_basis IN ('UNDISPUTED','UPHELD','CORRECTED','DEADLINE')),
  recorded_at     TIMESTAMPTZ,
  finalized_at    TIMESTAMPTZ,
  original_price_raw BIGINT,                      -- set if a dispute corrected the price
  close_price     NUMERIC(20,8),                  -- price * 10^expo, display only
  close_price_raw BIGINT, close_expo INT, close_conf BIGINT,
  publish_time    TIMESTAMPTZ,
  recorded_by     TEXT,
  recorded_sig    TEXT,
  UNIQUE (symbol, trading_date)
);

CREATE TABLE markets (
  pda             TEXT PRIMARY KEY,
  ticker_day_pda  TEXT NOT NULL REFERENCES ticker_days(pda),
  symbol          TEXT NOT NULL,
  trading_date    DATE NOT NULL,
  strike_cents    BIGINT NOT NULL,
  yes_mint        TEXT NOT NULL UNIQUE,
  no_mint         TEXT NOT NULL UNIQUE,
  vault           TEXT NOT NULL,
  book            TEXT,                           -- NULL after close_book
  status          TEXT NOT NULL CHECK (status IN ('TRADING','HALTED','SETTLED','VOID')),
  outcome         TEXT CHECK (outcome IN ('YES','NO','VOID')),
  created_by      TEXT NOT NULL,                  -- 'AUTO' | admin pubkey
  created_slot    BIGINT NOT NULL,
  settled_slot    BIGINT,
  pairs_outstanding BIGINT NOT NULL DEFAULT 0,
  total_volume_contracts BIGINT NOT NULL DEFAULT 0,
  UNIQUE (symbol, trading_date, strike_cents)
);
CREATE INDEX markets_by_day ON markets (trading_date, symbol);

CREATE TABLE disputes (                          -- D8
  ticker_day_pda  TEXT PRIMARY KEY REFERENCES ticker_days(pda),
  raised_by       TEXT NOT NULL,
  bond_micro      BIGINT NOT NULL,
  evidence_hash   TEXT NOT NULL,
  evidence_url    TEXT,                           -- off-chain, optional
  raised_at       TIMESTAMPTZ NOT NULL,
  result          TEXT CHECK (result IN ('UPHELD','CORRECTED','DEADLINE')),
  old_price_raw   BIGINT NOT NULL,
  new_price_raw   BIGINT,
  resolved_by     TEXT,
  resolved_at     TIMESTAMPTZ,
  raised_sig      TEXT NOT NULL,
  resolved_sig    TEXT
);

-- ===== Chain-derived: activity (append-only, idempotent on natural key) =====
CREATE TABLE chain_events (
  signature       TEXT NOT NULL,
  ix_index        INT  NOT NULL,
  event_index     INT  NOT NULL,
  slot            BIGINT NOT NULL,
  block_time      TIMESTAMPTZ,
  market_pda      TEXT,
  seq             BIGINT,
  kind            TEXT NOT NULL,                  -- 'Fill','OrderPlaced',...
  payload         JSONB NOT NULL,
  commitment      TEXT NOT NULL CHECK (commitment IN ('confirmed','finalized')),
  PRIMARY KEY (signature, ix_index, event_index)
);
CREATE INDEX chain_events_market_seq ON chain_events (market_pda, seq);

CREATE TABLE orders (
  market_pda      TEXT NOT NULL REFERENCES markets(pda),
  order_id        BIGINT NOT NULL,
  owner           TEXT NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('BID','ASK')),
  price_cents     SMALLINT NOT NULL CHECK (price_cents BETWEEN 1 AND 99),
  qty_original    BIGINT NOT NULL,
  qty_filled      BIGINT NOT NULL DEFAULT 0,
  tif             TEXT NOT NULL,
  tag             TEXT NOT NULL DEFAULT 'NONE',   -- 'NONE','BUY_NO'
  intent          TEXT NOT NULL,                  -- 'BUY_YES','SELL_YES','BUY_NO','SELL_NO'
  status          TEXT NOT NULL CHECK (status IN ('OPEN','PARTIAL','FILLED','CANCELLED')),
  cancel_reason   TEXT,
  placed_sig      TEXT NOT NULL,
  placed_at       TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (market_pda, order_id)
);
CREATE INDEX orders_owner_open ON orders (owner) WHERE status IN ('OPEN','PARTIAL');

CREATE TABLE fills (
  signature       TEXT NOT NULL,
  event_index     INT NOT NULL,
  market_pda      TEXT NOT NULL REFERENCES markets(pda),
  seq             BIGINT NOT NULL,
  maker_order_id  BIGINT NOT NULL,
  maker           TEXT NOT NULL,
  taker           TEXT NOT NULL,
  taker_side      TEXT NOT NULL,                  -- side of the Yes book the taker hit
  price_cents     SMALLINT NOT NULL,
  qty             BIGINT NOT NULL,
  taker_fee_micro BIGINT NOT NULL DEFAULT 0,
  maker_intent    TEXT NOT NULL,
  taker_intent    TEXT NOT NULL,
  slot            BIGINT NOT NULL,
  block_time      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (signature, event_index)
);
CREATE INDEX fills_market_time ON fills (market_pda, block_time DESC);
CREATE INDEX fills_maker ON fills (maker, block_time DESC);
CREATE INDEX fills_taker ON fills (taker, block_time DESC);

CREATE TABLE mint_merge_redeem (
  signature       TEXT NOT NULL,
  event_index     INT NOT NULL,
  market_pda      TEXT NOT NULL REFERENCES markets(pda),
  owner           TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('MINT','MERGE','REDEEM','WITHDRAW')),
  via             TEXT,                           -- DIRECT, BUY_NO, SELL_NO, CANCEL_BUY_NO
  yes_qty         BIGINT NOT NULL DEFAULT 0,
  no_qty          BIGINT NOT NULL DEFAULT 0,
  usdc_micro      BIGINT NOT NULL,                -- signed: + to user, - from user
  block_time      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (signature, event_index)
);

-- ===== Derived: positions and P&L (rebuilt from events) =====
CREATE TABLE positions (
  owner           TEXT NOT NULL,
  market_pda      TEXT NOT NULL REFERENCES markets(pda),
  yes_qty         BIGINT NOT NULL DEFAULT 0,      -- wallet + ledger free + locked
  no_qty          BIGINT NOT NULL DEFAULT 0,
  yes_cost_micro  BIGINT NOT NULL DEFAULT 0,      -- average-cost basis (A29)
  no_cost_micro   BIGINT NOT NULL DEFAULT 0,
  realized_pnl_micro BIGINT NOT NULL DEFAULT 0,
  ledger_free_usdc BIGINT NOT NULL DEFAULT 0,     -- unclaimed maker proceeds
  ledger_free_yes BIGINT NOT NULL DEFAULT 0,
  redeemed        BOOLEAN NOT NULL DEFAULT FALSE,
  last_seq        BIGINT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (owner, market_pda)
);
CREATE INDEX positions_owner ON positions (owner);

CREATE TABLE candles_1m (
  market_pda      TEXT NOT NULL,
  bucket          TIMESTAMPTZ NOT NULL,
  o SMALLINT, h SMALLINT, l SMALLINT, c SMALLINT,
  volume          BIGINT NOT NULL,
  PRIMARY KEY (market_pda, bucket)
);

-- ===== Indexer checkpoints =====
CREATE TABLE indexer_cursor (
  stream          TEXT PRIMARY KEY,               -- 'program_logs','redis_stream'
  last_slot       BIGINT NOT NULL,
  last_signature  TEXT,
  last_stream_id  TEXT,
  updated_at      TIMESTAMPTZ NOT NULL
);

-- ===== Automation / ops =====
CREATE TABLE oracle_updates (                     -- D2: the exact update reused on retries
  symbol          TEXT NOT NULL,
  trading_date    DATE NOT NULL,
  purpose         TEXT NOT NULL CHECK (purpose IN ('PREV_CLOSE','SETTLE')),
  target_time     TIMESTAMPTZ NOT NULL,
  publish_time    TIMESTAMPTZ NOT NULL,
  price_raw       BIGINT NOT NULL,
  expo            INT NOT NULL,
  conf            BIGINT NOT NULL,
  vaa             BYTEA NOT NULL,                 -- signed Hermes payload
  fetched_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (symbol, trading_date, purpose)
);

CREATE TABLE job_runs (
  id              BIGSERIAL PRIMARY KEY,
  job             TEXT NOT NULL,                  -- 'MORNING','SETTLE','STRIKE_CRANK','PRUNE','CLOSE_BOOK'
  trading_date    DATE NOT NULL,
  symbol          TEXT,
  attempt         INT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('RUNNING','OK','RETRY','FAILED','SKIPPED')),
  detail          JSONB,
  tx_sigs         TEXT[],
  started_at      TIMESTAMPTZ NOT NULL,
  finished_at     TIMESTAMPTZ
);
CREATE INDEX job_runs_day ON job_runs (trading_date, job);

CREATE TABLE alerts (
  id              BIGSERIAL PRIMARY KEY,
  severity        TEXT NOT NULL CHECK (severity IN ('INFO','WARN','PAGE')),
  code            TEXT NOT NULL,                  -- 'SETTLE_SLA_AT_RISK','ORACLE_CONF_WIDE',...
  symbol          TEXT,
  trading_date    DATE,
  message         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  acked_by        TEXT,
  acked_at        TIMESTAMPTZ
);

-- ===== Off-chain user data (only table the API writes) =====
CREATE TABLE user_prefs (
  owner           TEXT PRIMARY KEY,               -- wallet pubkey, auth via SIWS
  default_view    TEXT NOT NULL DEFAULT 'YES',
  slippage_cents  SMALLINT NOT NULL DEFAULT 2,
  updated_at      TIMESTAMPTZ NOT NULL
);
