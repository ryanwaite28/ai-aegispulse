# Spec — FR-TEN-08, FR-AUTH-06 (+ gateway routes for Phase 2) — Settings, gateway routes, authorization (slice 2c)

| | |
|---|---|
| Phase | 02 — Registry: Tenancy, Identity & RBAC, slice **2c** |
| Owner runtime(s) | `services/registry`, `gateway/nest-http`, kits (`ts-platform`, `py-platform`), `tests/` |
| Status | RUNTIME-VERIFIED locally (2026-11-23) |
| Related | ADR-0002, ADR-0010, ADR-0013; NFR-06, NFR-08, NFR-10 |

## 1. Requirement
- FR-TEN-08: tenant settings are readable via `getTenantSettings` and cached ≤ 60 s by callers. Changes emit `registry.tenant.settings_changed`.
- FR-AUTH-06: services enforce role + tenant ownership. Cross-tenant access returns 404. `PLATFORM_ADMIN` acts via `X-Aegis-Tenant`, recorded as `actingAs`.
- §11 Phase 2: gateway routes `/v1/auth/*`, `/v1/tenants*`, `/v1/users*`, `/v1/service-accounts*`, `/.well-known/jwks.json`; the role-matrix table test; the cross-tenant harness; E2E auth flows.

## 2. Behavior
- **`getTenantSettings`:**
  - PLATFORM_ADMIN: any tenant, except the platform tenant (404).
  - TENANT_ADMIN: its own tenant; any other is 404.
  - SERVICE callers: allowed with `registry.getTenantSettings` in `act[]`.
  - Every other role: 403.
  - Returns the `Tenant` shape, which the gateway's tenant detail shares.
- **`updateTenantSettings`** (PATCH `/v1/tenants/{id}` without `status`):
  - Access: TENANT_ADMIN for its own tenant, or PLATFORM_ADMIN.
  - At least one setting is required (422).
  - Only the fields that actually changed go into `changedFields` and the event. A no-op returns the tenant and emits no event.
  - Idempotency key: optional.
- **PATCH `/v1/tenants/{id}` with `status`** → `updateTenantStatus` (PLATFORM_ADMIN). The gateway picks the action from the contract's `oneOf` body shape.
- **Role matrix as data:**
  - Registry `domain/AccessPolicy` is the action → roles map, equal to the contract's `x-aegis-roles`. `AccessPolicyTest` reads `gateway.public.yaml` and checks every action × role.
  - Service-account actions are TENANT_ADMIN-only, as in §8.3.
  - Logout with an INTEGRATION token is a no-op 200 (the contract lists INTEGRATION).
- **Gateway** (transport only):
  - `@Operation(id)` binds a handler to its contract route. The guard verifies the token, then checks the caller's roles against that route's `x-aegis-roles`. These come from `generated/gateway-routes.json`, which `make contracts` emits from `gateway.public.yaml`.
  - Controllers: parse → one registry action → map to the §8.2 envelope with the gateway's own request and correlation ids.
  - Headers are forwarded explicitly: the bearer token, `X-Aegis-Tenant` (only on routes that declare it), and `Idempotency-Key`.
  - Login and refresh use the gateway's own SERVICE token (§5.7.4); `/v1/auth/token` fixes `audience=aegispulse`.
  - Registry errors pass through: status, code, message and details.
  - **Kit fix:** 429 answers are `HttpRateLimitedError`, kept out of the circuit breaker, so a throttled login storm cannot open the breaker for everyone.
- **Kit caches:** `TenantSettingsCache` in TS and Python. TTL is at most 60 s (clamped); concurrent misses share one fetch; failures are not cached; `invalidate` exists for consumers of `settings_changed`.

## 3. Data & contracts
- No migrations.
- Contracts:
  - `generated/gateway-routes.{ts,json}` (new generator output, exported as `@aegispulse/contracts/gateway-routes`);
  - `registry.internal.yaml` is unchanged.

## 4. Test plan
| Level | Test | Proves |
|---|---|---|
| Unit | `AccessPolicyTest` | registry action × role = contract, for every Phase-2 route |
| Unit | gateway `registry-routes.test.ts` (7) | service-token login; contract role denials never reach registry; header forwarding; list `nextCursor`; PATCH action selection; error + 429 pass-through; token audience; JWKS pass-through |
| Unit | ts-platform http-client (+2), tenant-settings (2); py `test_tenant_settings` (2) | pass-through, 429 outside breaker; cache TTL ≤ 60 s, shared misses, no failure caching |
| Integration | `TenantIT.FR_TEN_08_*` | settings read/update, event, service read, cross-tenant 404, analyst 403, empty update 422 |
| E2E (compose) | `tests/e2e/auth.e2e.test.ts` (4) | login → refresh rotation → reuse revokes family → logout; uniform 401 → 429; password change; integration token + JWKS |
| E2E | `tests/e2e/role-matrix.e2e.test.ts` (79) | 13 Phase-2 routes × 6 roles through the gateway (generated from the contract) |
| Security | `tests/security/cross-tenant.spec.ts` (2) | B's tenant/users/service accounts → 404 for A; lists scoped; TA cannot use X-Aegis-Tenant |

## 5. Deferred
- FR-TEN-08 "settings change propagates to scoring threshold within 60 s" needs risk-scoring, which is Phase 8; the test is tracked in Phase 8's FR-TXN-04 checklist.
- The Phase 2 JWKS rotation drill log: `scripts/dev/jwks-rotation-drill.sh`, operator-run.
