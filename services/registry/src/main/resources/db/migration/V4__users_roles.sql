-- V4: registry.users + registry.user_roles (PROJECT.md §7.1; FR-TEN-04/05/09) under tenant RLS (§7.0, ADR-0016).
CREATE TABLE registry.users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES registry.tenants(id),
  email                 CITEXT NOT NULL,
  display_name          TEXT NOT NULL,
  password_hash         TEXT NOT NULL,                 -- Argon2id PHC string
  must_change_password  BOOLEAN NOT NULL DEFAULT TRUE,
  status                TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  last_login_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_users_tenant_email ON registry.users (tenant_id, email);
CREATE INDEX ix_users_tenant_status ON registry.users (tenant_id, status);
CREATE INDEX ix_users_tenant_created ON registry.users (tenant_id, created_at, id);  -- listUsers keyset pagination
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON registry.users
  FOR EACH ROW EXECUTE FUNCTION registry.set_updated_at();

CREATE TABLE registry.user_roles (
  tenant_id   UUID NOT NULL REFERENCES registry.tenants(id),
  user_id     UUID NOT NULL REFERENCES registry.users(id),
  role        TEXT NOT NULL CHECK (role IN ('PLATFORM_ADMIN','TENANT_ADMIN','ANALYST','VIEWER','COMPLIANCE_AUDITOR')),
  granted_by  UUID REFERENCES registry.users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, role),
  -- FR-TEN-09: PLATFORM_ADMIN exists only in the reserved platform tenant, which holds nothing else
  CONSTRAINT ck_user_roles_platform CHECK ((tenant_id = '00000000-0000-0000-0000-000000000001') = (role = 'PLATFORM_ADMIN'))
);
CREATE INDEX ix_user_roles_tenant_role ON registry.user_roles (tenant_id, role);

ALTER TABLE registry.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry.users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON registry.users
  USING (tenant_id = registry.current_tenant())
  WITH CHECK (tenant_id = registry.current_tenant());

ALTER TABLE registry.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry.user_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON registry.user_roles
  USING (tenant_id = registry.current_tenant())
  WITH CHECK (tenant_id = registry.current_tenant());
