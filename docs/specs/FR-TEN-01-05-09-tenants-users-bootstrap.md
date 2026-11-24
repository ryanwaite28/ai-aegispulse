# Spec — FR-TEN-01 / 02 / 03 / 04 / 05 / 09 — Tenants, users and platform bootstrap (slice 2a)

| | |
|---|---|
| Phase | 02 — Registry: Tenancy, Identity & RBAC (`PROJECT.md` §11), slice **2a** |
| Owner runtime(s) | `services/registry` (gateway routes land in slice 2c) |
| Status | INTEGRATION-VERIFIED (2026-11-23); bootstrap runtime-verified locally |
| Related NFRs | NFR-02 (idempotency), NFR-06 (tenant isolation), NFR-07 (observability) |
| Related ADRs | ADR-0004 (outbox), ADR-0010 (tokens), ADR-0016 (enforced RLS bypass) |

## 1. Requirement (verbatim from PROJECT.md §2)
> - **FR-TEN-01**: `PLATFORM_ADMIN` creates a tenant with `slug` (`^[a-z0-9-]{3,40}$`, unique), `displayName` (1–120), `highValueThresholdUsd` (default 50000), `highRiskCountries` (ISO-3166 alpha-2 list), `demoMode` (default false), `retentionDays` (30–3650, default 400). Creates the tenant `ACTIVE`, emits `registry.tenant.created`, writes audit entry. Duplicate slug → `409 TENANT_SLUG_TAKEN`. Idempotent by `Idempotency-Key`.
> - **FR-TEN-02**: `PLATFORM_ADMIN` suspends (`SUSPENDED`) or restores (`ACTIVE`) a tenant with a reason. While suspended: logins fail `403 TENANT_SUSPENDED`, webhooks for its sources return `403`, transaction/file submissions are rejected, consumers **still archive** in-flight events (no data loss) but sagas skip case creation and emit `ops` warnings. Emits `registry.tenant.suspended|restored`.
> - **FR-TEN-03**: `PLATFORM_ADMIN` deactivates a tenant (`DEACTIVATED`, terminal): all credentials revoked, sources disabled, data retained until retention purge (FR-EVT-07, FR-FILE-12). Hard delete is out of scope.
> - **FR-TEN-04**: `TENANT_ADMIN` invites/creates users with `email` (RFC 5322, unique per tenant, stored lower-case), `displayName`, `roles[]` (non-empty subset of §1.4.6 tenant roles), and an initial password (≥ 14 chars, zxcvbn score ≥ 3) that must be changed at first login (`mustChangePassword`). Passwords hashed with Argon2id (m=64 MiB, t=3, p=1).
> - **FR-TEN-05**: `TENANT_ADMIN` lists (filter by role, status; paginated), updates roles, disables, and re-enables users. A tenant must always retain ≥ 1 active `TENANT_ADMIN` (`409 LAST_TENANT_ADMIN`). Role changes revoke the user's refresh tokens and emit `registry.user.changed`; audited.
> - **FR-TEN-09**: Platform bootstrap (reserved `platform` tenant, `bootstrap-platform-admin` command; see `PROJECT.md` §2.1).

Effects that belong to other runtimes or later slices are **not** in 2a. Each is listed in §9 with the slice or phase that owns it.

## 2. Behavior

### Principal and acting tenant (applies to every action below)
- Every action requires an authenticated **user** principal (`typ=user`). A SERVICE or INTEGRATION principal gets `403 FORBIDDEN`. None of these actions is in any runtime's `act[]` allowlist (§5.7.4).
- **Tenant actions** (`createTenant`, `updateTenantStatus`) require the `PLATFORM_ADMIN` role. Otherwise the result is `403 FORBIDDEN`.
- **User actions** (`createUser`, `listUsers`, `updateUser`) resolve the *effective tenant* as follows:
  - `TENANT_ADMIN` uses the token's `tid`. Sending `X-Aegis-Tenant` returns `403 FORBIDDEN` (§6.2).
  - `PLATFORM_ADMIN` must send `X-Aegis-Tenant`; without it the result is `403 FORBIDDEN`. An unknown tenant, or the reserved `platform` tenant, returns `404 NOT_FOUND`. The change event records `actingAs = "PLATFORM_ADMIN"`.
  - Any other role gets `403 FORBIDDEN`.
- Every user query runs in a transaction that first calls `TenantScope.apply(effectiveTenant)`. Under RLS, a user id from another tenant reads 0 rows, which returns `404 NOT_FOUND` (FR-AUTH-06).

### createTenant (FR-TEN-01)
1. Validate the input against `CreateTenantInput`. Defaults: threshold `50000`, countries `[]`, `demoMode=false`, retention 400. Country codes are upper-case alpha-2 and de-duplicated.
2. `Idempotency-Key` is **mandatory** (FR says "idempotent by"); a missing key returns `422 VALIDATION_ERROR`. The record is scoped to `(PA's tenant = platform, 'createTenant', key)`.
   - The same key with the same body replays the stored 201.
   - The same key with a different body returns `409 IDEMPOTENCY_KEY_REUSED`.
3. Insert into `registry.tenants`. A unique violation on `ux_tenants_slug` returns `409 TENANT_SLUG_TAKEN`. Slug `platform` always collides with the reserved row.
4. In the same transaction, write the outbox event `registry.tenant.created` with `{tenantId, slug, actorId, changedFields}`. The event is the audit record that cases chains in Phase 8 (FR-AUD-02).

### updateTenantStatus (FR-TEN-02 / 03)
- State machine (pure domain):
  - `ACTIVE → SUSPENDED` emits `registry.tenant.suspended` with the reason.
  - `SUSPENDED → ACTIVE` emits `registry.tenant.restored`.
  - `ACTIVE | SUSPENDED → DEACTIVATED` is terminal and emits `registry.tenant.deactivated` with the reason (amendment 2026-11-23).
  - Every other transition, including same-status and anything out of `DEACTIVATED`, returns `409 CONFLICT`.
- The reserved `platform` tenant, or an unknown id, returns `404 NOT_FOUND`.
- `reason` is 1–500 characters (matching the event schema `maxLength`) and is stored in `status_reason`.
- `Idempotency-Key` is optional; when present it is honored as in createTenant.
- **Deactivation effects:** registry itself refuses login, refresh and client credentials for a DEACTIVATED tenant (2b). Other runtimes apply their suspension gate permanently in their own phases; cases audits the event (Phase 8).

### createUser (FR-TEN-04)
1. Validation:
   - The email is RFC 5322 (the Jakarta `@Email` subset), at most 320 characters, trimmed and lower-cased.
   - `displayName` is at least 1 character (the contract sets no maximum; request body limits apply).
   - Roles are a non-empty set of `TENANT_ADMIN | ANALYST | VIEWER | COMPLIANCE_AUDITOR`.
2. Password policy (`domain/PasswordPolicy`): 14–256 characters, and an nbvcxz score of at least 3. nbvcxz also gets the email local part, the display name and the tenant slug as user-specific dictionary words, the equivalent of zxcvbn `user_inputs`. A failure returns `422 AUTH_PASSWORD_POLICY`. The response never echoes the password.
3. Hash with Argon2id (m = 65536 KiB, t = 3, p = 1, 32-byte tag, 16-byte salt; PHC string). Insert into `users` (`must_change_password = true`) and `user_roles` (`granted_by` = actor when the actor is in the same tenant, otherwise null).
4. `ux_users_tenant_email` violation → `409 USER_EMAIL_TAKEN`.
5. Outbox `registry.user.changed` `{userId, changedFields: [email, displayName, roles, status], actorId, actingAs?}`. Optional payload fields are omitted, never sent as `null`: the event schemas do not allow null.
6. The `Idempotency-Key` fingerprint covers email, display name and roles, **not** the password, so the stored request hash never encodes a secret. A retry with the same key and a different password replays the original response.

### listUsers (FR-TEN-05)
- Filters: `role`, `status`. Order is `(created_at, id)` ascending. `limit` runs 1–100 (default 25, `PageQuery`).
- `cursor` is an opaque base64url of `created_at|id`, and a malformed cursor returns `422 VALIDATION_ERROR`.
- `meta.nextCursor` is null on the last page.

### updateUser (FR-TEN-05)
- At least one of `displayName`, `roles`, `status` is required.
- The tenant row is locked `FOR UPDATE` so that concurrent admin changes serialize per tenant.
- If the change would leave the tenant with zero `ACTIVE` users holding `TENANT_ADMIN` (by dropping the role, or by disabling the user), the result is `409 LAST_TENANT_ADMIN`.
- Role sets are replaced, not merged.
- `changedFields` lists only the fields that actually changed. A no-op update returns 200 and emits no event.
- Role change or disable → refresh-token revocation: **2b** adds `refresh_tokens`, and this hook is wired there; see §9.

### bootstrap-platform-admin (FR-TEN-09)
- Start: `java -jar app.jar bootstrap-platform-admin`. In compose this is service `registry-bootstrap`, profile `tools`; in Kubernetes it is a Job (Phase 9). It runs with no web server, executes once and exits.
  - Exit 0 means the user was created or the command was a no-op.
  - Exit 2 means the configuration or policy is invalid. The message names the variable, never its value.
- In one transaction scoped to the `platform` tenant:
  1. Lock the `platform` tenant row.
  2. If any `ACTIVE` user holds `PLATFORM_ADMIN`, log `bootstrap.noop` and exit 0.
  3. Otherwise validate the email and the FR-TEN-04 password policy, create the user with role `PLATFORM_ADMIN` and `must_change_password = true`, and enqueue `registry.user.changed` with no `actorId` (SYSTEM actor).
- The DB enforces that `PLATFORM_ADMIN` exists **only** in the `platform` tenant, and that the `platform` tenant holds **only** `PLATFORM_ADMIN` (CHECK on `user_roles`).

## 3. Data & migrations
- `V3__tenants.sql`: `registry.tenants` exactly as §7.1, with the `set_updated_at` trigger. It has **no RLS**, because it is the platform table (§11 checklist). `svc_registry` gets DML through default privileges.
- `V4__users_roles.sql`: `registry.users`, `registry.user_roles` as §7.1, with `set_updated_at` on users, RLS `tenant_isolation` on both (the §7.0 pattern), and CHECK `ck_user_roles_platform` = `(tenant_id = '00000000-0000-0000-0000-000000000001') = (role = 'PLATFORM_ADMIN')`.
- `R__platform_tenant.sql`: `INSERT … ('00000000-0000-0000-0000-000000000001','platform','Platform') ON CONFLICT (id) DO NOTHING`.
- No SECURITY DEFINER functions are needed in 2a: tenants has no RLS, and every user query has a tenant context. Pre-tenant auth lookups arrive in 2b.
- Readiness `min-flyway-version` goes from 2 to 4.

## 4. Contracts
- Internal actions (`registry.internal.yaml`): `createTenant`, `updateTenantStatus`, `createUser`, `listUsers`, `updateUser`. The user actions take `X-Aegis-Tenant` (added in this slice, §6.2 clarification).
- Public routes (§8.3, wired in 2c): `POST /v1/tenants`, `PATCH /v1/tenants/{id}` (status part), `GET/POST /v1/users`, `PATCH /v1/users/{id}`. The user routes allow `TENANT_ADMIN`, or `PLATFORM_ADMIN` with `X-Aegis-Tenant`.
- Errors: `TENANT_SLUG_TAKEN`, `USER_EMAIL_TAKEN`, `LAST_TENANT_ADMIN`, `AUTH_PASSWORD_POLICY`, `IDEMPOTENCY_KEY_REUSED`, `CONFLICT`, `NOT_FOUND`, `FORBIDDEN`, `VALIDATION_ERROR`.
- Events (`aegispulse.domain`), schemas `packages/contracts/events/registry.tenant.{created,suspended,restored,deactivated}.v1.schema.json` and `registry.user.changed.v1.schema.json`:
  - Envelope `classification = {sensitivity: INTERNAL, status: INGESTED, classification_source: PRODUCER}`.
  - `source = service:registry`.
  - The shared `registryChange` gains optional `actingAs` (additive, v1.x).

## 5. Layer placement
| Piece | File |
|---|---|
| Domain (pure) | `registry/domain/{TenantStatus,TenantStateMachine,TenantRole,PasswordPolicy,EmailAddress,LastAdminRule,PlatformTenant}.java` |
| Service / use case | `registry/service/{TenantService,UserService,ActingContext,PasswordHasher,RegistryEvents,PlatformAdminBootstrap}.java` |
| Repository | `registry/db/{TenantRepository,UserRepository}.java` |
| Internal route adapter | `registry/adapters/http/{TenantController,UserController}.java` (parse → one service call → map) |
| Command adapter | `registry/adapters/cli/BootstrapPlatformAdminCommand.java` (runner → `PlatformAdminBootstrap.run()`) |
| Gateway handler + client | slice 2c |

## 6. Security & observability
- Passwords exist only in request DTOs and in `PasswordHasher`. They are never logged, never written to events, and never returned. Hashes never leave the repository layer, and the `User` DTO has no hash field.
- The email is PII: logs carry `userId` only and never the email.
- Spans come from the Spring/JDBC auto-instrumentation (OTel agent). Logs: `tenant.created`, `tenant.status_changed`, `user.created`, `user.updated`, `bootstrap.created|noop`, with `tenantId`, `userId` and `actorId`.

## 7. Test plan
| Level | Test name (includes FR id) | Proves |
|---|---|---|
| Unit | `TenantStateMachineTest` `FR_TEN_02_03_*` | the allowed transitions; DEACTIVATED is terminal; same-status returns 409 |
| Unit | `PasswordPolicyTest` `FR_TEN_04_*` | length bounds; weak/strong scoring; user inputs penalized |
| Unit | `LastAdminRuleTest` `FR_TEN_05_*` | removal or disable of the last active TA rejected |
| Unit | `PasswordHasherTest` `FR_TEN_04_argon2id_params` | the PHC string carries `m=65536,t=3,p=1`; verify round-trip |
| Integration (Testcontainers PG + RabbitMQ) | `TenantIT` `FR_TEN_01_*`, `FR_TEN_02_*` | create → 201 + outbox row; duplicate slug 409; idempotent replay; key reuse 409; `platform` slug 409; suspend/restore events; non-PA 403 |
| Integration | `UserIT` `FR_TEN_04_*`, `FR_TEN_05_*` | create; email case-insensitive 409; weak password 422; list filters and pagination; last-admin 409; cross-tenant 404; PA needs `X-Aegis-Tenant`; TA with header 403 |
| Integration | `PlatformBootstrapIT` `FR_TEN_09_*` | first run creates a PA (must change password); second run no-op; PA creates tenant and its first TA via `X-Aegis-Tenant`; DB CHECK rejects a PA role outside `platform` |
| Runtime (compose) | `registry-bootstrap` run twice | exit 0 both times; one PA row |

## 8. Acceptance (runtime evidence required)
- [x] `./gradlew :registry:test :registry:integrationTest` is green: 24 unit + 13 integration ([phase-02a](../evidence/phase-02a.md)).
- [x] `docker compose --profile tools run --rm registry-bootstrap` run twice logs `bootstrap.created`, then `bootstrap.noop` (both exit 0); the missing-config path exits 2 and names variables only.
- [x] `make migrate` applies V3, V4 and R__platform_tenant; registry `/readyz` is 200 with min version 4.

## 9. Deferred to later slices / open items
- **2b:** refresh-token revocation on role change or disable (needs `refresh_tokens`). Login is refused for `SUSPENDED` (`403 TENANT_SUSPENDED`) and `DEACTIVATED` tenants. Credential revocation on deactivation: in registry, login, refresh and client-credentials all check tenant status.
- **2c:** gateway routes and the role-matrix table tests.
- **Phase 4/5/8:** effects in other runtimes (webhook 403, rejected submissions, saga skip, audit chain).
