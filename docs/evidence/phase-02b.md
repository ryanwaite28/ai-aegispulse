# Phase 02 (slice 2b) — Authentication, JWKS, client credentials, service accounts — Exit Evidence

| | |
|---|---|
| Commit SHA | base `5f71541` + uncommitted slice 2b working tree |
| Date (UTC) | 2026-11-23 |
| Environment(s) | local (macOS arm64, OpenJDK 25.0.5.1, Gradle 9.9.2, Node 24, Python 3.13, Docker). Testcontainers: PostgreSQL 18.7 (init script + `aegispulse-migrate:test`; app as `svc_registry` under RLS), RabbitMQ 4.4.1 (contract topology), Redis 8.10.3 **rendered from the compose ACL template** (the app connects as the `registry` ACL user) |
| Pipeline | pending: commit + push |
| Verified by | Claude Code (Opus) |
| Resulting status | Slice 2b `INTEGRATION-VERIFIED` + local runtime verified |

## Scope
Spec: [FR-AUTH-01-05-07-TEN-06-07-auth-service-accounts](../specs/FR-AUTH-01-05-07-TEN-06-07-auth-service-accounts.md).
Decisions:
- [ADR-0017](../adr/0017-service-account-secret-reconciliation.md);
- the amendment of 2026-11-23, which added client-credentials throttling, the JWKS source, keeping the current session on password change, the integration principal type for `/me`, and the `registry.service_account.changed` and `registry.auth.refresh_reuse_detected` events.

## Commands and results
### Unit
```
./gradlew :java-platform:test :registry:test → java-platform 35/35 (+JwksRotationTest), registry 29/29 (+bounded-hashing test)
make test-unit → contracts 15, ts-platform 52 (+jwks-rotation.test.ts), services 8, gateway 4, Python (+test_jwks_rotation.py), Java OK
```

### Integration (`./gradlew :registry:integrationTest`): 29 tests, 0 failures
| Class | Tests | Proves |
|---|---|---|
| `AuthIT` | 9 | Login token claims match §2.2 (kid, aud, iss, typ, tid, tslug, roles, jti, exp−iat = 900 s) and the registry accepts its own token. 5 wrong passwords → uniform 401, then 429 even with the right password. Unknown user and unknown tenant get identical messages. Suspended tenant → 403 `TENANT_SUSPENDED` for login and refresh. Refresh rotation; reusing a rotated token revokes the family and emits `registry.auth.refresh_reuse_detected`. Expiry after 7 d (clock). `/me` + logout. changePassword: wrong current 401, weak 422, keeps only the named session, `mustChangePassword` cleared. Role change revokes refresh. Login needs the gateway's `registry.login` act |
| `ClientCredentialsIT` | 5 | The `svc-gateway` token has exactly its §5.7.4 `act[]`, the internal audience and no `tid`. 10 wrong secrets → 401, then 429. ADR-0017 reconciliation: ROTATED_IN / UNCHANGED / MISSING; the old secret is valid during the 24 h grace and rejected after it (clock). INTEGRATION lifecycle: create (secret shown once; an `Idempotency-Key` repeat → 409, never replayed), token claims, `/me`, wrong audience 401, rotate grace, revoke, list without secrets, 3 audit events, verifiers stored as Argon2id. Cross-tenant 404. Suspended tenant → 403 |
| `JwksIT` | 2 | Public keys only (no `d`/`p`), `application/jwk-set+json`, `max-age=600`. **Rotation drill:** after a new key registers, the JWKS lists [new, previous], logins sign with the new kid, and previous-key tokens are still accepted. After 24 h (clock) the previous key is retired and its tokens get 401 |
| 2a suites | 13 | Still green with the real signing path (the test-only decoder override was removed) |

**Mutation check:** with the login `throttle.check` removed, `AuthIT.FR_AUTH_01_uniformFailuresThenRateLimitedPerTenantAndEmail` fails. Restored afterwards.

**Kit rotation tests** run against a local HTTP JWKS server. Each one serves k1, then rotates to [k2, k1]; a k2 token verifies after a refetch, and k1 still verifies.
- Java refetches at once.
- TS (`jose`) and Python (PyJWT 2.15) refetch after their cooldown, which was 30 s and is now 5 s (see the phase-02c drill). The tests advance time.

### Static checks
- `make lint`: exit 0.
- `make check`: boundaries and migrations OK; ci self-tests 10/10.
- `make typecheck`, `make contracts` (41 events), Prettier, shellcheck: all OK.

### Local runtime (compose)
Applied: `make migrate` (V5, V6, R seed service accounts: Success), the registry ACL re-rendered with `~ratelimit:cc:*`, and the operator ran `scripts/dev/ensure-local-vars.sh` (added the PEM and 9 SERVICE secrets).

Registry startup:
```
signing_key.registered kid=local-2026-11 previous=none
service_accounts.reconciled {UNCHANGED=2, ROTATED_IN=7}   (first start), {UNCHANGED=9} on later starts
```

End-to-end check from a container on the compose network. Secrets are interpolated by compose; the script prints statuses only, never a token or password.
```
1  jwks 200 application/jwk-set+json max-age=600, public [('local-2026-11', 'RS256', no private part)]
2  svc-gateway token 200 kid local-2026-11 typ service aud aegispulse-internal act [registry.login, registry.refreshToken, ingestion.ingestWebhookDelivery] ttl 900
3  PA login 200 typ user tslug platform roles [PLATFORM_ADMIN] mustChangePassword True
4  /me 200 user [PLATFORM_ADMIN] platform mustChangePassword True
5  createTenant 201
6  PA creates first TA via X-Aegis-Tenant 201
7  TA login 200 mustChangePassword True
8  changePassword 200
9  old pw 401, new pw 200, mustChangePassword False
10 kept session refresh 200
11 load: 80 token requests x16 concurrent → {200: 52, 429: 28}; registry restarts 0, 661/768 MiB
registry.outbox_events → registry.tenant.created SENT, registry.user.changed SENT
```

**Defects found at runtime and fixed:**
1. **Heap sizing.** The registry crash-looped (11 restarts, killed silently by the memory limit) at the §3 rule `MaxRAMPercentage=70`. About 290 MiB sits outside the heap, and Argon2id fills the heap. Measured with the hashing bound in place:

   | Heap cap | Result | Peak |
   |---|---|---|
   | 70 % | crash loop | 759/768 MiB |
   | 55 % | stable | 714 MiB |
   | 50 % | stable | 667 MiB |

   The amendment (approved) sets **50 %** for all JVM services; cases also starts cleanly at 332 MiB.
2. **Unbounded Argon2id concurrency.** 8 concurrent verifications on the unauthenticated client-credentials action caused `OutOfMemoryError: Java heap space` and an exit. `PasswordHasher` now allows 2 concurrent operations in a fair queue; a caller waiting more than 10 s gets 429 `RATE_LIMITED`. A unit test asserts peak concurrency = 2.
3. **Local helper.** `ensure-local-vars.sh` had skipped a `.env.example` placeholder PEM line. It now replaces placeholder and empty lines.

## Not yet verified / deferred
- Gateway routes for `/v1/auth/*`, `/v1/service-accounts*` and the JWKS proxy; role-matrix tests; cross-tenant suite; E2E: slice 2c.
- The environment rotation drill on dev (Phase 2 exit; runbook "Drill").
