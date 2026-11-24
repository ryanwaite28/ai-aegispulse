-- V8: watchlists + entries (PROJECT.md §7.1; FR-ENT-04/05) under tenant RLS (§7.0, ADR-0016).
CREATE TABLE registry.watchlists (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES registry.tenants(id),
  name            TEXT NOT NULL,
  reason          TEXT NOT NULL,
  severity_floor  TEXT NOT NULL DEFAULT 'HIGH' CHECK (severity_floor IN ('INFO','LOW','MEDIUM','HIGH','CRITICAL')),
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED')),
  deleted_at      TIMESTAMPTZ,
  created_by      UUID REFERENCES registry.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_watchlists_tenant_name ON registry.watchlists (tenant_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX ix_watchlists_tenant_created ON registry.watchlists (tenant_id, created_at, id);  -- keyset list
CREATE TRIGGER trg_watchlists_updated_at BEFORE UPDATE ON registry.watchlists
  FOR EACH ROW EXECUTE FUNCTION registry.set_updated_at();

CREATE TABLE registry.watchlist_entries (
  watchlist_id  UUID NOT NULL REFERENCES registry.watchlists(id),
  entity_id     UUID NOT NULL REFERENCES registry.entities(id),
  tenant_id     UUID NOT NULL REFERENCES registry.tenants(id),
  note          TEXT,
  added_by      UUID REFERENCES registry.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (watchlist_id, entity_id)
);
CREATE INDEX ix_watchlist_entries_entity ON registry.watchlist_entries (tenant_id, entity_id);

ALTER TABLE registry.watchlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry.watchlists FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON registry.watchlists
  USING (tenant_id = registry.current_tenant())
  WITH CHECK (tenant_id = registry.current_tenant());
ALTER TABLE registry.watchlist_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry.watchlist_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON registry.watchlist_entries
  USING (tenant_id = registry.current_tenant())
  WITH CHECK (tenant_id = registry.current_tenant());
