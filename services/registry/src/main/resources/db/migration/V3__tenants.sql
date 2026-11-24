-- V3: registry.tenants (PROJECT.md §7.1; FR-TEN-01/02/03). Platform table: no RLS (tenant rows are not tenant-owned data;
-- every read is authorized in the service layer). svc_registry receives DML through default privileges.
CREATE TABLE registry.tenants (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                      TEXT NOT NULL CHECK (slug ~ '^[a-z0-9-]{3,40}$'),
  display_name              TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  status                    TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DEACTIVATED')),
  status_reason             TEXT,
  high_value_threshold_usd  NUMERIC(22,4) NOT NULL DEFAULT 50000,
  high_risk_countries       TEXT[] NOT NULL DEFAULT '{}',          -- ISO-3166 alpha-2
  retention_days            INT NOT NULL DEFAULT 400 CHECK (retention_days BETWEEN 30 AND 3650),
  demo_mode                 BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_tenants_slug ON registry.tenants (slug);
CREATE INDEX ix_tenants_status ON registry.tenants (status);
CREATE TRIGGER trg_tenants_updated_at BEFORE UPDATE ON registry.tenants
  FOR EACH ROW EXECUTE FUNCTION registry.set_updated_at();
