-- V7: tracked entities + aliases (PROJECT.md §7.1; FR-ENT-01/02/03) under tenant RLS (§7.0, ADR-0016).
-- pg_trgm lives in schema public (created by the init/bootstrap script).
CREATE TABLE registry.entities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES registry.tenants(id),
  name             TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  normalized_name  TEXT NOT NULL,                   -- lower, punctuation + legal suffix stripped
  entity_type      TEXT NOT NULL CHECK (entity_type IN ('ORGANIZATION','TICKER','COUNTERPARTY','AGENCY','PERSON')),
  ticker           TEXT CHECK (ticker ~ '^[A-Z.]{1,10}$'),
  lei              TEXT CHECK (lei ~ '^[A-Z0-9]{20}$'),
  country          TEXT CHECK (country ~ '^[A-Z]{2}$'),
  archived_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_entities_tenant_norm ON registry.entities (tenant_id, normalized_name) WHERE archived_at IS NULL;
CREATE INDEX ix_entities_tenant_ticker ON registry.entities (tenant_id, ticker) WHERE ticker IS NOT NULL;
CREATE INDEX ix_entities_trgm ON registry.entities USING gin (normalized_name public.gin_trgm_ops);
CREATE INDEX ix_entities_tenant_created ON registry.entities (tenant_id, created_at, id);  -- keyset list
CREATE TRIGGER trg_entities_updated_at BEFORE UPDATE ON registry.entities
  FOR EACH ROW EXECUTE FUNCTION registry.set_updated_at();

CREATE TABLE registry.entity_aliases (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES registry.tenants(id),
  entity_id         UUID NOT NULL REFERENCES registry.entities(id),
  alias             TEXT NOT NULL,
  normalized_alias  TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_alias_tenant_norm ON registry.entity_aliases (tenant_id, normalized_alias);
CREATE INDEX ix_alias_entity ON registry.entity_aliases (entity_id);
CREATE INDEX ix_alias_trgm ON registry.entity_aliases USING gin (normalized_alias public.gin_trgm_ops);

ALTER TABLE registry.entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry.entities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON registry.entities
  USING (tenant_id = registry.current_tenant())
  WITH CHECK (tenant_id = registry.current_tenant());
ALTER TABLE registry.entity_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry.entity_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON registry.entity_aliases
  USING (tenant_id = registry.current_tenant())
  WITH CHECK (tenant_id = registry.current_tenant());
