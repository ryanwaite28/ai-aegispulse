-- V4: cases and their history (PROJECT.md §7.4; FR-CASE-01..08) under tenant RLS. History tables are append-only for
-- the service role (no UPDATE/DELETE), cases rows are updated under optimistic locking (version).
CREATE TABLE cases.case_number_sequences (
  tenant_id   UUID NOT NULL,
  year        INT NOT NULL,
  next_value  INT NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, year)
);

CREATE TABLE cases.cases (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL,
  case_number           TEXT NOT NULL CHECK (case_number ~ '^AP-[0-9]{4}-[0-9]{6}$'),
  case_type             TEXT NOT NULL CHECK (case_type IN ('TRANSACTION_RISK','DOCUMENT_RISK','EXTRACTION_REVIEW','CORRELATED')),
  status                TEXT NOT NULL CHECK (status IN ('OPEN','ENRICHING','POLICY_EVALUATED','ESCALATED','CLEARED','RESOLVED')),
  severity              TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  policy_score          INT CHECK (policy_score BETWEEN 0 AND 100),
  policy_version        TEXT,
  primary_entity_ids    UUID[] NOT NULL DEFAULT '{}',
  trigger_event_id      UUID NOT NULL,
  trigger_file_id       UUID,
  open_idempotency_key  TEXT NOT NULL,
  previous_case_id      UUID REFERENCES cases.cases(id),
  assignee_user_id      UUID,
  pending_disposition   TEXT CHECK (pending_disposition IN ('NEEDS_REVIEW')),
  pending_reviewer_id   UUID,
  enrichment_deadline   TIMESTAMPTZ,
  resolved_at           TIMESTAMPTZ,
  version               INT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_cases_tenant_number ON cases.cases (tenant_id, case_number);
CREATE UNIQUE INDEX ux_cases_open_idem ON cases.cases (tenant_id, open_idempotency_key);
CREATE INDEX ix_cases_tenant_status_sev ON cases.cases (tenant_id, status, severity, created_at DESC);
CREATE INDEX ix_cases_entities ON cases.cases USING gin (primary_entity_ids);
CREATE INDEX ix_cases_enrichment_deadline ON cases.cases (enrichment_deadline) WHERE status = 'ENRICHING';
CREATE INDEX ix_cases_assignee ON cases.cases (tenant_id, assignee_user_id) WHERE assignee_user_id IS NOT NULL;
CREATE TRIGGER trg_cases_updated_at BEFORE UPDATE ON cases.cases FOR EACH ROW EXECUTE FUNCTION cases.set_updated_at();

CREATE TABLE cases.case_transitions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  case_id         UUID NOT NULL REFERENCES cases.cases(id),
  transition_key  TEXT NOT NULL,
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  trigger_type    TEXT NOT NULL CHECK (trigger_type IN ('EVENT','USER','TIMER','SYSTEM')),
  trigger_ref     TEXT,
  case_version    INT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_case_transition_key ON cases.case_transitions (case_id, transition_key);
CREATE INDEX ix_case_transitions_case ON cases.case_transitions (case_id, created_at);

CREATE TABLE cases.policy_evaluations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  case_id         UUID NOT NULL REFERENCES cases.cases(id),
  revision        INT NOT NULL,
  policy_version  TEXT NOT NULL,
  policy_score    INT NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('ESCALATED','CLEARED')),
  factors         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_policy_eval_case_rev ON cases.policy_evaluations (case_id, revision);

CREATE TABLE cases.case_evidence (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  case_id         UUID NOT NULL REFERENCES cases.cases(id),
  evidence_type   TEXT NOT NULL CHECK (evidence_type IN ('EVENT','FILE','EXTRACTION','RISK_EVALUATION','WATCHLIST_HIT')),
  evidence_ref    TEXT NOT NULL,
  final_severity  TEXT,
  summary         JSONB NOT NULL DEFAULT '{}',
  attached_by     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_case_evidence ON cases.case_evidence (case_id, evidence_type, evidence_ref);

CREATE TABLE cases.case_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  case_id     UUID NOT NULL REFERENCES cases.cases(id),
  author_id   UUID NOT NULL,
  body        TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  locked_at   TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_case_notes_case ON cases.case_notes (case_id, created_at);
CREATE TRIGGER trg_case_notes_updated_at BEFORE UPDATE ON cases.case_notes FOR EACH ROW EXECUTE FUNCTION cases.set_updated_at();

CREATE TABLE cases.case_dispositions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  case_id          UUID NOT NULL REFERENCES cases.cases(id),
  disposition      TEXT NOT NULL CHECK (disposition IN ('TRUE_POSITIVE','FALSE_POSITIVE','NEEDS_REVIEW')),
  rationale        TEXT NOT NULL CHECK (char_length(rationale) >= 20),
  analyst_id       UUID NOT NULL,
  model_versions   TEXT[] NOT NULL DEFAULT '{}',
  rule_versions    TEXT[] NOT NULL DEFAULT '{}',
  policy_version   TEXT,
  idempotency_key  TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_dispositions_idem ON cases.case_dispositions (tenant_id, idempotency_key);
CREATE INDEX ix_dispositions_case ON cases.case_dispositions (case_id, created_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['case_number_sequences','cases','case_transitions','policy_evaluations','case_evidence',
                           'case_notes','case_dispositions'] LOOP
    EXECUTE format('ALTER TABLE cases.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE cases.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON cases.%I USING (tenant_id = cases.current_tenant())'
                   ' WITH CHECK (tenant_id = cases.current_tenant())', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON cases.%I FROM svc_cases', t);
  END LOOP;
END $$;
-- History is append-only for the service role: transitions, policy evaluations, evidence and dispositions.
REVOKE UPDATE ON cases.case_transitions, cases.policy_evaluations, cases.case_evidence, cases.case_dispositions
  FROM svc_cases;
