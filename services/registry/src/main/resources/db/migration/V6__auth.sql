-- V6: refresh tokens + signing keys (PROJECT.md §7.1; FR-AUTH-01/02/03/05/07; ADR-0016).
CREATE TABLE registry.refresh_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES registry.tenants(id),
  user_id       UUID NOT NULL REFERENCES registry.users(id),
  family_id     UUID NOT NULL,                      -- rotation family; reuse revokes family
  token_sha256  TEXT NOT NULL,                      -- never store raw token
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ROTATED','REVOKED')),
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_refresh_token_hash ON registry.refresh_tokens (token_sha256);
CREATE INDEX ix_refresh_family ON registry.refresh_tokens (family_id);
CREATE INDEX ix_refresh_user ON registry.refresh_tokens (user_id, status);
CREATE TRIGGER trg_refresh_tokens_updated_at BEFORE UPDATE ON registry.refresh_tokens
  FOR EACH ROW EXECUTE FUNCTION registry.set_updated_at();
ALTER TABLE registry.refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry.refresh_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON registry.refresh_tokens
  USING (tenant_id = registry.current_tenant())
  WITH CHECK (tenant_id = registry.current_tenant());

GRANT SELECT ON registry.refresh_tokens TO registry_platform;

-- Refresh-token lookup before tenant context (FR-AUTH-02): resolves the tenant; everything after runs under RLS.
CREATE FUNCTION registry.refresh_token_lookup(p_token_sha256 text)
  RETURNS TABLE (id uuid, tenant_id uuid, user_id uuid, family_id uuid, status text, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.id, r.tenant_id, r.user_id, r.family_id, r.status, r.expires_at
  FROM registry.refresh_tokens r WHERE r.token_sha256 = p_token_sha256
$$;
ALTER FUNCTION registry.refresh_token_lookup(text) OWNER TO registry_platform;
REVOKE ALL ON FUNCTION registry.refresh_token_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.refresh_token_lookup(text) TO svc_registry;

CREATE TABLE registry.signing_keys (               -- public halves only; private keys live in Infisical
  kid            TEXT PRIMARY KEY,
  public_jwk     JSONB NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('CURRENT','PREVIOUS','RETIRED')),
  activated_at   TIMESTAMPTZ NOT NULL,
  retired_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_signing_keys_status ON registry.signing_keys (status);
CREATE UNIQUE INDEX ux_signing_keys_one_current ON registry.signing_keys ((status)) WHERE status = 'CURRENT';
