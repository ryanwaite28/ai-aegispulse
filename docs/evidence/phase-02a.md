# Phase 02 (slice 2a) — Tenants, users and platform bootstrap — Exit Evidence

| | |
|---|---|
| Commit SHA | base `bb04097` + uncommitted slice 2a working tree |
| Date (UTC) | 2026-11-23 |
| Environment(s) | local (macOS arm64, OpenJDK 25.0.5.1, Gradle 9.9.2, Docker). Testcontainers: PostgreSQL 18.7 (init script + `aegispulse-migrate:test`; app connects as `svc_registry`, so RLS applies) and RabbitMQ 4.4.1 (contract topology; `svc_registry` with its compose permissions). Compose stack for the runtime checks |
| Pipeline | pending: first GitLab pipeline after commit + push |
| Verified by | Claude Code (Opus) |
| Resulting status | Slice 2a `INTEGRATION-VERIFIED` (bootstrap runtime-verified locally); Phase 2 `IN PROGRESS` |

## Scope
Spec: [FR-TEN-01-05-09-tenants-users-bootstrap](../specs/FR-TEN-01-05-09-tenants-users-bootstrap.md). This covers FR-TEN-01/02/03 (registry side), FR-TEN-04/05 and FR-TEN-09. Gateway routes, login, and refresh-token revocation belong to slices 2b and 2c.

| Piece | Where |
|---|---|
| Migrations | `V3__tenants.sql` (no RLS: platform table), `V4__users_roles.sql` (RLS on both tables, `ck_user_roles_platform`), `R__platform_tenant.sql` |
| Domain | `PlatformTenant`, `Role`, `TenantStatus`/`TenantStateMachine`, `EmailAddress`, `PasswordPolicy` (nbvcxz ≥ 3, 14–256 chars, user inputs penalized), `LastAdminRule`, `Tenant`/`User` |
| Service | `TenantService`, `UserService`, `TenantAccess` (TA own tenant; PA via `X-Aegis-Tenant`), `PasswordHasher` (Argon2id m=64 MiB t=3 p=1), `RegistryEvents` (outbox), `Idempotency`, `PlatformAdminBootstrap` |
| Adapters | `TenantController`, `UserController` (`POST /internal/v1/{action}`), `BootstrapPlatformAdminCommand` (`java -jar app.jar bootstrap-platform-admin`, non-web, exit 0/2) |
| Kit | java-platform `UuidV7` (envelope `eventId`); servlet-only auto-config beans now `@ConditionalOnWebApplication`, so one-shot commands start without a web server |
| Contracts | `X-Aegis-Tenant` on the internal and public user actions, `PLATFORM_ADMIN` on the `/v1/users*` roles, optional `actingAs` on registry events (additive v1.x) |

## Commands and results

### Unit (`./gradlew :java-platform:test :registry:test`)
```
packages/java-platform tests 34 failures 0 errors 0 skipped 0   (+2 UuidV7Test)
services/registry      tests 24 failures 0 errors 0 skipped 0
```
Registry unit tests:
- `TenantStateMachineTest` (9 cases)
- `PasswordPolicyTest` (5)
- `LastAdminRuleTest` (3)
- `EmailAndRoleTest` (3)
- `PasswordHasherTest` (the PHC string carries `$argon2id$v=19$m=65536,t=3,p=1$`)
- `UserServiceCursorTest` (2)
- `ArchitectureTest` (layering rules; now non-vacuous)

### Integration (`./gradlew :registry:integrationTest`): 13 tests, 0 failures
| Test | Proves |
|---|---|
| `TenantIT.FR_TEN_01_createsActiveTenantWithDefaultsAndPublishesEvent` | 201, defaults (threshold `"50000"` as a string, 400 days, demo off), countries de-duplicated and sorted; `registry.tenant.created` arrives on `cases.audit-ingest.q` |
| `TenantIT.FR_TEN_01_idempotentReplayAndKeyReuse` | same key + body replays the same id; same key + different body → 409 `IDEMPOTENCY_KEY_REUSED` |
| `TenantIT.FR_TEN_01_duplicateAndReservedSlugsConflict` | 409 `TENANT_SLUG_TAKEN`, including slug `platform` |
| `TenantIT.FR_TEN_01_requiresPlatformAdminUserTokenAndIdempotencyKey` | no token 401; TA 403; a SERVICE token holding `act=[registry.createTenant]` is still 403 (user-only); missing key 422; bad slug 422 |
| `TenantIT.FR_TEN_02_03_suspendRestoreDeactivate` | ACTIVE→SUSPENDED→ACTIVE→DEACTIVATED; same-status 409; terminal 409; suspended/restored/deactivated events carry the reason |
| `TenantIT.FR_TEN_09_platformTenantAndUnknownTenantsAreNotManageable` | 404 for the platform tenant and for unknown ids |
| `UserIT.FR_TEN_04_tenantAdminCreatesUsersWithPolicyAndUniqueEmail` | lower-cased email; `mustChangePassword`; no hash or password in responses; case-insensitive 409 `USER_EMAIL_TAKEN`; weak password 422 `AUTH_PASSWORD_POLICY` (not echoed); PA role 422; the event has the actor, no `actingAs` and no email |
| `UserIT.FR_TEN_05_listFiltersAndPaginates` | role filter; 5 users over 3 pages of 2 in creation order; garbage cursor 422 |
| `UserIT.FR_TEN_05_lastTenantAdminIsProtected` | demote or disable the last TA → 409 `LAST_TENANT_ADMIN`; allowed once a second TA exists; `changedFields` lists only the real change |
| `UserIT.FR_AUTH_06_crossTenantUsersReadAsNotFound` | TA of tenant A updating B's user → 404; list shows only A's users (RLS) |
| `UserIT.FR_TEN_09_platformAdminActsOnlyViaXAegisTenant` | PA without the header 403; platform or unknown target 404; PA-created user event has `actingAs=PLATFORM_ADMIN`; TA sending the header 403; ANALYST 403 |
| `PlatformBootstrapIT.FR_TEN_09_firstRunCreatesSecondRunIsNoop` | weak password rejected; first run CREATED (email lower-cased, `must_change_password`), second run NOOP; the SYSTEM-actor event has no `actorId` |
| `PlatformBootstrapIT.FR_TEN_09_platformAdminRoleIsConfinedToThePlatformTenant` | DB CHECK `ck_user_roles_platform` rejects `PLATFORM_ADMIN` outside the platform tenant |

The suite decodes every envelope it drains with the platform `EnvelopeCodec` (envelope schema). It also validates each **payload against `packages/contracts/events/{eventType}.v1.schema.json`**.

**Defect found and fixed:** the generated payload records serialized unset optional fields as JSON `null` (`actorId`, `actingAs`), which the event schemas reject. `RegistryEvents` now omits them.

**Negative check:** with that pruning disabled, the payload check fails 6 of the 13 tests (`/actorId: null found, string expected`, `/actingAs: … enumeration`). With it restored, all 13 pass.

### Runtime (local compose)
```
make migrate
  registry: | Versioned  | 3 | tenants         | Success |
  registry: | Versioned  | 4 | users roles     | Success |
  registry: | Repeatable |   | platform tenant | Success |
docker compose up -d --build registry  →  compose-wait: … 12 runtimes pass /readyz
curl 127.0.0.1:8084/readyz                                   → {"status":"UP"}   (min Flyway version 4)
POST 127.0.0.1:8084/internal/v1/listUsers (no token)         → 401
registry.tenants                                             → platform|ACTIVE
docker compose --profile tools run --rm registry-bootstrap   → exit 2,
  "bootstrap.failed reason=missing_config variables=PLATFORM_ADMIN_BOOTSTRAP_EMAIL,PLATFORM_ADMIN_BOOTSTRAP_PASSWORD"
```
This exercises the non-web startup (no Tomcat, no security filter chain) and the missing-config path, which names only the variables.

After the operator ran `scripts/dev/ensure-local-vars.sh`:
```
registry-bootstrap (run 1) → "bootstrap.created userId=acc20c48-…"  "bootstrap.done outcome=CREATED"   exit=0
registry-bootstrap (run 2) → "bootstrap.noop reason=active_platform_admin_exists" "bootstrap.done outcome=NOOP" exit=0
registry.users ⋈ user_roles → PLATFORM_ADMIN | admin@aegispulse.local | must_change_password=t | ACTIVE
registry.outbox_events      → registry.user.changed | SENT | attempts 0   (relayed by the running registry)
```

### Static checks
- `ci/lint-java.sh`: OK (Error Prone + NullAway, google-java-format).
- `make check`: boundaries OK, migrations OK (new files only); ci self-tests 10/10.
- `make typecheck`: OK.
- `make contracts`: OK.
- Prettier: OK on the changed docs, YAML and schemas.
- shellcheck: OK on `scripts/dev/*.sh`.

## Not yet verified / deferred
- Gateway routes `/v1/tenants*`, `/v1/users*` and the role-matrix table tests: slice 2c.
- Refresh-token revocation on role change or disable; login refused for SUSPENDED/DEACTIVATED tenants (and the E2E for it): slice 2b.
- `registry.tenant.deactivated` was added by amendment (2026-11-23). Registry emits it, and `TenantIT.FR_TEN_02_03_suspendRestoreDeactivate` checks it against the new schema. Effects outside registry (sources disabled, audit chain) land in Phases 4/8.
- MB-15 (dev/prod first PLATFORM_ADMIN) is a 🛑 MANUAL step at the Phase 9 first deploy.
