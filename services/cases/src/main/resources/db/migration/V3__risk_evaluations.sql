-- V3: risk evaluations (PROJECT.md §7.4; FR-TXN-05) under tenant RLS (§7.0, ADR-0016). Idempotent by
-- (tenant_id, idempotency_key = risk-eval:{eventId}). svc_cases: SELECT/INSERT/UPDATE only (§5.7.2).
CREATE TABLE cases.risk_evaluations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL,
  idempotency_key       TEXT NOT NULL,
  transaction_event_id  UUID NOT NULL,
  transaction_id        UUID NOT NULL,
  account_id            TEXT NOT NULL,
  counterparty_id       TEXT NOT NULL,
  score                 INT NOT NULL CHECK (score BETWEEN 0 AND 100),
  band                  TEXT NOT NULL CHECK (band IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  factors               JSONB NOT NULL,
  model_version         TEXT NOT NULL,
  feature_version       TEXT NOT NULL,
  watchlist_hits        JSONB NOT NULL DEFAULT '[]',
  case_id               UUID,
  suppressed_reason     TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_risk_eval_idem ON cases.risk_evaluations (tenant_id, idempotency_key);
CREATE INDEX ix_risk_eval_tenant_time ON cases.risk_evaluations (tenant_id, created_at DESC);
CREATE INDEX ix_risk_eval_case ON cases.risk_evaluations (case_id) WHERE case_id IS NOT NULL;
CREATE INDEX ix_risk_eval_transaction ON cases.risk_evaluations (tenant_id, transaction_id, created_at DESC);

ALTER TABLE cases.risk_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases.risk_evaluations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cases.risk_evaluations
  USING (tenant_id = cases.current_tenant()) WITH CHECK (tenant_id = cases.current_tenant());
REVOKE DELETE, TRUNCATE ON cases.risk_evaluations FROM svc_cases;
