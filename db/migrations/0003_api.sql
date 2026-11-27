-- Phase 6 (API) addition to the Section 5 schema. Contract change: listed in
-- docs/phase6-coverage.md so it can be promoted into architecture-spec.md Section 5.
-- Written only by the REST API (C4).

-- MER-64: every admin call, accepted or refused, with the caller and payload.
CREATE TABLE admin_audit (
  id              BIGSERIAL PRIMARY KEY,
  caller          TEXT NOT NULL,                  -- JWT subject (wallet), or 'anonymous'
  route           TEXT NOT NULL,                  -- 'POST /v1/admin/tx/pause'
  payload         JSONB NOT NULL,                 -- params, query and body as received
  status          INT NOT NULL,                   -- HTTP status returned
  error_code      TEXT,                           -- spec 7 error code when refused
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_caller ON admin_audit (caller, created_at);
