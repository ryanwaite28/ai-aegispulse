# Phase 02 (slice 2c) — Settings, gateway routes, role matrix, cross-tenant suite, E2E — Exit Evidence

| | |
|---|---|
| Commit SHA | base `5f71541` + uncommitted slices 2b–2c working tree |
| Date (UTC) | 2026-11-23 |
| Environment(s) | local compose stack (all 12 runtimes `/readyz` 200); Testcontainers for registry integration |
| Pipeline | pending: commit + push |
| Verified by | Claude Code (Opus) |
| Resulting status | Slice 2c `RUNTIME-VERIFIED` locally; Phase 2 `IN PROGRESS` (rotation drill log + pipeline open) |

## Scope
Spec: [FR-TEN-08-AUTH-06-settings-gateway-authz](../specs/FR-TEN-08-AUTH-06-settings-gateway-authz.md).

## Commands and results
```
./gradlew :registry:test :registry:integrationTest → registry unit 30/30 (+AccessPolicyTest), integration 30/30 (+FR_TEN_08)
make test-unit → contracts 15, ts-platform 56 (+http-client pass-through/429, +tenant-settings), gateway 11 (+7), services 8; Python OK (+2); Java OK
make lint (exit 0) · make typecheck · make check (boundaries, migrations OK) · make contracts (OK; new gateway-routes table)
```

### E2E through the gateway (`make test-e2e`, compose stack)
```
Test Files  3 passed (3)
     Tests  85 passed (85)
  e2e/auth.e2e.test.ts            4  login → refresh rotation → reuse revokes family → logout; 5×401 (uniform) → 429;
                                     password change keeps only the named session; integration token + JWKS
  e2e/role-matrix.e2e.test.ts    79  13 Phase-2 routes × 6 roles (generated from gateway-routes.json) + coverage check
  security/cross-tenant.spec.ts   2  B's tenant/users/service accounts → 404 for A; lists scoped; TA + X-Aegis-Tenant → 403
```
The harness creates two fresh tenants per run (`e2e-<run>-a|b`), a user per tenant role, and an INTEGRATION account. It logs in as the bootstrap PLATFORM_ADMIN, whose password reaches the test process from `.env` and is never printed or changed.

Gateway smoke run before the E2E:
- `/.well-known/jwks.json` → 200 `application/jwk-set+json`.
- An unknown login → `401 AUTH_INVALID_CREDENTIALS` with the gateway's own `meta`. The gateway fetched its SERVICE token from the registry first.

### JWKS rotation drill (operator-run, `scripts/dev/jwks-rotation-drill.sh`, 2026-11-24 04:50 UTC)
```
1 before:   jwks=['local-2026-11'] new-login kid=local-2026-11 /me(new)=200
2 rotated:  jwks=['drill-20261124045005', 'local-2026-11'] new-login kid=drill-20261124045005 /me(new)=401
            /me(token from before rotation, kid=local-2026-11)=200
3 restored: jwks=['local-2026-11', 'drill-20261124045005'] new-login kid=local-2026-11 /me(new)=200
            /me(token from before rotation, kid=local-2026-11)=200
```
The rotation mechanics hold:
- The JWKS publishes current + previous.
- New tokens carry the new kid.
- Tokens signed by the previous key are accepted (FR-AUTH-05).
- The restore works.

**Finding: step 2 `/me(new)=401`.** The gateway's TS verifier (`jose`) had fetched the JWKS within its 30 s refetch cooldown, so it rejected the first new-kid token. The registry restart takes less than 30 s. **Fix:** the refetch cooldown is now 5 s in all three kits (TS, Python, Java); the rotation unit tests were updated. Rerunning the drill after the next rebuild should show `/me(new)=200` in step 2.

## JWKS rotation drill rerun (2026-11-24, run by Claude Code after the 5 s refetch-cooldown fix)
```
scripts/dev/jwks-rotation-drill.sh
1 before:   jwks=[local-2026-11, drill-20261124045005] new-login kid=local-2026-11 /me(new)=200
2 rotated:  jwks=[drill-20261124190628, local-2026-11, …] new-login kid=drill-20261124190628 /me(new)=200
            /me(token from before rotation, kid=local-2026-11)=200
3 restored: jwks=[local-2026-11, drill-20261124190628, …] new-login kid=local-2026-11 /me(new)=200
            /me(token from before rotation)=200
```
Step 2 is 200 right after rotation; the first drill's 30 s 401 window is gone. The drill key stays PREVIOUS for 24 h, then retires.

## Pending (Phase 2 exit)
- Commit + green first GitLab pipeline.
- FR-TEN-08 scoring propagation test → Phase 8 (risk-scoring; tracked in its checklist).
- Dev-environment rotation drill (Phase 9).
