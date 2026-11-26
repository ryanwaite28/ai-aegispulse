-- FK without a leading index (architecture review, §12 migrations rule): previous_case_id is the link followed when
-- a resolved case spawns a correlated successor (FR-CASE-08), and deleting/looking up by it must not scan.
CREATE INDEX IF NOT EXISTS ix_cases_previous_case ON cases.cases (previous_case_id) WHERE previous_case_id IS NOT NULL;
