-- V5: service accounts (PROJECT.md §7.1; FR-TEN-06/07, FR-AUTH-04; ADR-0016, ADR-0017).
CREATE TABLE registry.service_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID REFERENCES registry.tenants(id),   -- null for internal SERVICE accounts
  client_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('INTEGRATION','SERVICE')),
  allowed_actions TEXT[] NOT NULL DEFAULT '{}',          -- act[] claim for SERVICE accounts (§5.7.4)
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_by    UUID REFERENCES registry.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_service_accounts_tenant CHECK ((kind = 'SERVICE') = (tenant_id IS NULL))
);
CREATE UNIQUE INDEX ux_service_accounts_client_id ON registry.service_accounts (client_id);
CREATE INDEX ix_service_accounts_tenant ON registry.service_accounts (tenant_id);
CREATE INDEX ix_service_accounts_tenant_created ON registry.service_accounts (tenant_id, created_at, id);
CREATE TRIGGER trg_service_accounts_updated_at BEFORE UPDATE ON registry.service_accounts
  FOR EACH ROW EXECUTE FUNCTION registry.set_updated_at();

CREATE TABLE registry.service_account_secrets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_account_id  UUID NOT NULL REFERENCES registry.service_accounts(id),
  secret_hash         TEXT NOT NULL,                -- Argon2id
  valid_until         TIMESTAMPTZ,                  -- set to now()+24h on rotation for the previous secret
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_sa_secrets_account ON registry.service_account_secrets (service_account_id);

-- Tenant scope sees its INTEGRATION accounts only; SERVICE accounts (tenant NULL) are reachable solely through the
-- definer functions below. Secrets follow the visibility of their account.
ALTER TABLE registry.service_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry.service_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON registry.service_accounts
  USING (tenant_id = registry.current_tenant())
  WITH CHECK (tenant_id = registry.current_tenant());
ALTER TABLE registry.service_account_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry.service_account_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON registry.service_account_secrets
  USING (EXISTS (SELECT 1 FROM registry.service_accounts a WHERE a.id = service_account_id))
  WITH CHECK (EXISTS (SELECT 1 FROM registry.service_accounts a WHERE a.id = service_account_id));

GRANT SELECT, INSERT, UPDATE ON registry.service_accounts, registry.service_account_secrets TO registry_platform;

-- Client-credentials lookup before any tenant context (FR-AUTH-04). Returns one row per verifier (or one row with null
-- secret columns); validity windows are evaluated by the service against its clock.
CREATE FUNCTION registry.client_credentials_lookup(p_client_id text)
  RETURNS TABLE (id uuid, tenant_id uuid, kind text, allowed_actions text[], status text,
                 secret_hash text, valid_until timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.id, a.tenant_id, a.kind, a.allowed_actions, a.status, s.secret_hash, s.valid_until
  FROM registry.service_accounts a
  LEFT JOIN registry.service_account_secrets s ON s.service_account_id = a.id
  WHERE a.client_id = p_client_id
$$;
ALTER FUNCTION registry.client_credentials_lookup(text) OWNER TO registry_platform;
REVOKE ALL ON FUNCTION registry.client_credentials_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.client_credentials_lookup(text) TO svc_registry;

-- SERVICE secret reconciliation (ADR-0017): open verifiers get a grace deadline, then the new verifier is added.
-- Only ACTIVE SERVICE accounts qualify; returns false for anything else.
CREATE FUNCTION registry.add_service_account_secret(p_client_id text, p_secret_hash text, p_grace_until timestamptz)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT a.id INTO v_id FROM registry.service_accounts a
   WHERE a.client_id = p_client_id AND a.kind = 'SERVICE' AND a.status = 'ACTIVE';
  IF v_id IS NULL THEN
    RETURN false;
  END IF;
  UPDATE registry.service_account_secrets
     SET valid_until = p_grace_until
   WHERE service_account_id = v_id AND (valid_until IS NULL OR valid_until > p_grace_until);
  INSERT INTO registry.service_account_secrets (service_account_id, secret_hash) VALUES (v_id, p_secret_hash);
  RETURN true;
END
$$;
ALTER FUNCTION registry.add_service_account_secret(text, text, timestamptz) OWNER TO registry_platform;
REVOKE ALL ON FUNCTION registry.add_service_account_secret(text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.add_service_account_secret(text, text, timestamptz) TO svc_registry;

-- Seeded SERVICE client ids for startup reconciliation (ADR-0017); SERVICE rows are invisible under tenant RLS.
CREATE FUNCTION registry.service_client_ids()
  RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.client_id FROM registry.service_accounts a WHERE a.kind = 'SERVICE' AND a.status = 'ACTIVE' ORDER BY 1
$$;
ALTER FUNCTION registry.service_client_ids() OWNER TO registry_platform;
REVOKE ALL ON FUNCTION registry.service_client_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.service_client_ids() TO svc_registry;
