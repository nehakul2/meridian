-- Phase 4 (automation) additions to the Section 5 schema. Contract change: listed in
-- docs/phase4-coverage.md so it can be promoted into architecture-spec.md Section 5.
-- Written only by Automation (C8).

-- D13 / spec 4.7 rule 2: the official closing-auction print the settler fetched from
-- both vendors, stored once and never swapped. Also the source of the next trading
-- day's previous close (A14, ORC-18).
CREATE TABLE official_closes (
  symbol          TEXT NOT NULL REFERENCES tickers(symbol),
  trading_date    DATE NOT NULL,
  price_cents     BIGINT NOT NULL CHECK (price_cents > 0), -- NOCP, whole cents
  massive_cents   BIGINT NOT NULL,
  massive_at      TIMESTAMPTZ NOT NULL,                     -- when Massive returned it
  databento_cents BIGINT NOT NULL,
  databento_at    TIMESTAMPTZ NOT NULL,
  stored_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (massive_cents = price_cents AND databento_cents = price_cents), -- never one vendor
  PRIMARY KEY (symbol, trading_date)
);

-- MER-47: one diff report per reconcile run.
CREATE TABLE reconcile_reports (
  id              BIGSERIAL PRIMARY KEY,
  trading_date    DATE NOT NULL,
  missing_count   INT NOT NULL,
  mismatch_count  INT NOT NULL,
  invariant_breaks INT NOT NULL,
  diff            JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reconcile_reports_day ON reconcile_reports (trading_date);

-- Alerts are raised idempotently per (code, symbol, date) while open.
CREATE INDEX alerts_open ON alerts (code, symbol, trading_date) WHERE acked_at IS NULL;
