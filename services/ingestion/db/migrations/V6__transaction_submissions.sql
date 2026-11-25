-- V6: transaction submissions (PROJECT.md §7.2; FR-TXN-01/06) under tenant RLS (§7.0, ADR-0016). The submission row and
-- its txn.submitted outbox row commit together. (tenant_id, idempotency_key) is the idempotency key; request_sha256
-- detects reuse of a key with a different body. submitted_by is the actor reference (user:{uuid} | integration:{clientId}).
CREATE TABLE ingestion.transaction_submissions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  idempotency_key   TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_sha256    TEXT NOT NULL,
  event_id          UUID NOT NULL,
  correlation_id    TEXT NOT NULL,
  account_id        TEXT NOT NULL,
  counterparty_id   TEXT NOT NULL,
  counterparty_name TEXT NOT NULL,
  amount            NUMERIC(22,4) NOT NULL CHECK (amount > 0),
  currency          CHAR(3) NOT NULL,
  country           CHAR(2) NOT NULL,
  channel           TEXT NOT NULL CHECK (channel IN ('WIRE','ACH','CARD','CRYPTO','INTERNAL')),
  occurred_at       TIMESTAMPTZ NOT NULL,
  metadata          JSONB NOT NULL DEFAULT '{}',
  source_file_id    UUID,
  source_row        INT,
  submitted_by      TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_txn_tenant_idem ON ingestion.transaction_submissions (tenant_id, idempotency_key);
CREATE UNIQUE INDEX ux_txn_event_id ON ingestion.transaction_submissions (event_id);
CREATE INDEX ix_txn_tenant_account_time ON ingestion.transaction_submissions (tenant_id, account_id, occurred_at DESC);
CREATE INDEX ix_txn_source_file ON ingestion.transaction_submissions (source_file_id) WHERE source_file_id IS NOT NULL;

ALTER TABLE ingestion.transaction_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.transaction_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ingestion.transaction_submissions
  USING (tenant_id = ingestion.current_tenant())
  WITH CHECK (tenant_id = ingestion.current_tenant());
