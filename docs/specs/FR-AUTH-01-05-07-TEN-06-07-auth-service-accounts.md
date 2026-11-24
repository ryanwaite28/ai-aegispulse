# Spec — FR-AUTH-01/02/03/04/05/07, FR-TEN-06/07 — Authentication, JWKS and service accounts (slice 2b)

| | |
|---|---|
| Phase | 02 — Registry: Tenancy, Identity & RBAC (`PROJECT.md` §11), slice **2b** |
| Owner runtime(s) | `services/registry`; kits (JWKS cache); gateway routes are slice 2c |
| Status | INTEGRATION-VERIFIED + local runtime verified (2026-11-23) |
| Related NFRs | NFR-02, NFR-06, NFR-07, NFR-08 |
| Related ADRs | ADR-0010 (tokens), ADR-0016 (definer functions), ADR-0017 (SERVICE secret reconciliation) |

## 1. Requirement
The verbatim text is in `PROJECT.md` §2.1 (FR-TEN-06/07) and §2.2 (FR-AUTH-01..05, 07), as amended on 2026-11-23 by ADR-0017. The amendment added:
- client-credentials throttling;
- the JWKS source being `signing_keys`;
- `changePassword` keeping the current session;
- `Principal.typ = integration`;
- the `registry.service_account.changed` and `registry.auth.refresh_reuse_detected` events.

## 2. Behavior

### Signing keys and JWKS (FR-AUTH-05)
- **Startup** (web mode only; skipped by one-shot commands):
  1. Parse `JWT_SIGNING_KEY_CURRENT_PEM` (PKCS#8 RSA ≥ 2048) and `JWT_SIGNING_KEY_CURRENT_KID`. A missing or invalid value fails startup, and the error names only the variable.
  2. Under an advisory lock, register the public JWK as `CURRENT`. A different former `CURRENT` becomes `PREVIOUS` with `retired_at = now`. A `PREVIOUS` older than 24 h becomes `RETIRED`.
  3. Delete `auth:jwks:cache`.
- **`GET /.well-known/jwks.json`** is public:
  - It returns a bare RFC 7517 set: `CURRENT`, plus `PREVIOUS` keys whose `retired_at` is within 24 h. Each key carries `kid`, `alg=RS256` and `use=sig`.
  - The serialized set is cached in Redis `auth:jwks:cache` (600 s), and the response sends `Cache-Control: public, max-age=600`.
- The registry verifies incoming tokens against the same published set, in-process, with no HTTP call to itself.
- **Kits** (Java, TS, Python) cache the remote JWKS for 10 min and refetch on an unknown `kid`. All three wait out a 5 s refetch cooldown, lowered from 30 s after the local rotation drill. Each kit has a rotation test.

### Token issuance (FR-AUTH-01/04, FR-TEN-07)
- RS256, header `kid` + `typ=JWT`, `iss=JWT_ISSUER`, `jti` (UUID), `iat`, `exp = iat + 900`.
- Claim sets by type:
  - **user:** `aud=JWT_AUDIENCE`, `sub` (user id), `typ=user`, `tid`, `tslug`, `roles[]`.
  - **integration:** `aud=JWT_AUDIENCE`, `sub` (clientId), `typ=integration`, `tid`, `tslug`, `roles=["INTEGRATION"]`.
  - **service:** `aud=aegispulse-internal`, `sub` (`svc-{runtime}`), `typ=service`, `act[]`.
- Time comes from an injected `Clock`, so expiry, grace periods and retirement are tested with a controlled clock.

### login (FR-AUTH-01): `registry.login`, called by the gateway with its SERVICE token
1. Throttle key `ratelimit:auth:{tenantId|nil-uuid}:{sha256(lower(email))}`. At ≥ 5 failures → `429 AUTH_RATE_LIMITED`.
2. Credential failures all return `401 AUTH_INVALID_CREDENTIALS` with the same message, and each increments the counter (TTL 900 s on first failure):
   - unknown tenant;
   - unknown email;
   - `DISABLED` user;
   - wrong password.
   Unknown tenant and unknown email still run an Argon2id verify against a fixed dummy hash, to equalize timing.
3. Valid credentials but tenant `SUSPENDED|DEACTIVATED` → `403 TENANT_SUSPENDED` (not counted as a failure).
4. Success:
   1. Reset the counter and set `last_login_at`.
   2. Start a new refresh family: a 32-byte base64url token, stored only as `sha256` hex, `expires_at = now + 7 d`.
   3. Return `TokenPair{accessToken, refreshToken, tokenType: Bearer, expiresIn: 900, mustChangePassword}`.

### refreshToken (FR-AUTH-02): gateway SERVICE token
1. Look up the hash through the SECURITY DEFINER `registry.refresh_token_lookup` (it runs before any tenant context; ADR-0016). Then apply that tenant's scope.
2. The outcome depends on what the lookup finds:
   - Not found or expired → `401 AUTH_REFRESH_INVALID`.
   - `REVOKED` → 401.
   - `ROTATED` (**reuse**) → revoke the whole family, emit `registry.auth.refresh_reuse_detected{userId, familyId}`, then 401. The revoke and the event commit **before** the 401 is returned.
   - Tenant not `ACTIVE` → `403 TENANT_SUSPENDED`.
   - User not `ACTIVE` → revoke the family, then 401.
3. Otherwise, rotate. A conditional `UPDATE … SET status='ROTATED' WHERE status='ACTIVE'` that changes 0 rows counts as a reuse race. The new token joins the same family with a fresh 7-day expiry. Return a new `TokenPair` whose roles come from the DB.

### logout / changePassword / getCurrentPrincipal (FR-AUTH-03/07): user token
- **logout:** if the token belongs to the caller, revoke its family. Otherwise do nothing and return `200 {}`, so as not to reveal whether a token exists.
- **changePassword:**
  1. Verify the current password. A wrong one → `401 AUTH_INVALID_CREDENTIALS` and counts toward the login throttle.
  2. Apply the FR-TEN-04 policy, store the new Argon2id hash, and set `must_change_password = false`.
  3. Revoke every family of the user except the one named by an optional, valid `refreshToken`.
  4. Emit `registry.user.changed{changedFields:["password"]}`.
- **getCurrentPrincipal:** returns `Principal` for any token type:
  - user: profile + tenant;
  - integration: the service-account id, `roles=[INTEGRATION]`, and the tenant;
  - service: `tenant: null`, `roles: []`.

### issueClientCredentialsToken (FR-AUTH-04, FR-TEN-07): unauthenticated
1. Throttle key `ratelimit:cc:{sha256(clientId)}`. At ≥ 10 failures in 300 s → `429 AUTH_RATE_LIMITED`.
2. Look up the account through the SECURITY DEFINER `registry.client_credentials_lookup` and verify the secret against every verifier with `valid_until` null or in the future.
3. Any of the following is a failure (counted) → `401 AUTH_INVALID_CREDENTIALS`:
   - unknown client;
   - revoked account;
   - no secret matches;
   - audience mismatch (INTEGRATION must ask for `aegispulse`, which maps to `JWT_AUDIENCE`; SERVICE must ask for `aegispulse-internal`).
4. INTEGRATION accounts whose tenant is not `ACTIVE` → `403 TENANT_SUSPENDED`.
5. Success returns `AccessToken{accessToken, tokenType, expiresIn: 900}`. There is no refresh token.

### SERVICE accounts (FR-TEN-07, ADR-0017)
- `R__seed_service_accounts.sql` sets `role registry_platform` and upserts the 9 §5.7.4 accounts (`svc-{runtime}`, `kind=SERVICE`, `tenant_id NULL`, `allowed_actions`).
- **Startup reconciliation**, for each seeded client:
  - It reads `SERVICE_CLIENT_SECRET_{RUNTIME}` (upper case, `-`→`_`).
  - If the value verifies against an open-ended verifier, nothing changes.
  - Otherwise `registry.add_service_account_secret` gives the open verifiers a 24 h grace and inserts the new one.
  - A missing variable logs `service_account.secret_missing clientId=…` (a warning, not fatal).

### INTEGRATION service accounts (FR-TEN-06): TENANT_ADMIN, or PLATFORM_ADMIN via `X-Aegis-Tenant`
- **create `{name}`:**
  - `clientId = int_` + 16 random bytes base64url;
  - `clientSecret` = 32 random bytes base64url, returned once as `ServiceAccountWithSecret`;
  - an Argon2id verifier is stored;
  - emits `registry.service_account.changed{changedFields:["created"]}`.
- **rotate:** the open verifiers get `valid_until = now + 24 h`; a new secret is returned once with `previousSecretValidUntil`. Emits `["secret"]`.
- **revoke:** `status = REVOKED` (tokens can no longer be issued). Emits `["status"]`. Revoking an already revoked account is a 200 no-op.
- **list:** keyset pagination; summaries only.
- **`Idempotency-Key` on create/rotate:** the key de-duplicates, but the response is **not** replayed, because it holds a one-time secret that must never be stored. A repeat returns `409 IDEMPOTENCY_KEY_REUSED` ("secret already issued; rotate to get a new one"). The idempotency record stores only the account id.
- Under RLS, an id from another tenant → 404.

### Deferred from 2a, now wired
- A role change or disable in `updateUser` revokes all the user's refresh families.
- Login, refresh and client credentials refuse `SUSPENDED`/`DEACTIVATED` tenants, which completes FR-TEN-03's "credentials revoked" inside registry.

## 3. Data & migrations
- **`V5__service_accounts.sql`:** `service_accounts` and `service_account_secrets` (§7.1).
  - RLS: accounts by `tenant_id` (SERVICE rows with NULL tenant are invisible to tenant scope); secrets through `EXISTS` on a visible account.
  - Definer functions `client_credentials_lookup(text)` and `add_service_account_secret(text, text, timestamptz)`, owned by `registry_platform`, with EXECUTE granted to `svc_registry` only.
- **`V6__auth.sql`:**
  - `refresh_tokens` (RLS) and the definer `refresh_token_lookup(text)`;
  - `signing_keys`, a platform table with no RLS (public halves only).
- **`R__seed_service_accounts.sql`:** the §5.7.4 allowlist.
- Readiness min Flyway version: 6.

## 4. Contracts
- **Internal actions:** `login`, `refreshToken`, `logout`, `changePassword`, `getCurrentPrincipal`, `issueClientCredentialsToken`, `createServiceAccount`, `listServiceAccounts`, `rotateServiceAccountSecret`, `revokeServiceAccount`. Service-account actions take `X-Aegis-Tenant` (§6.2).
- **Public routes:** `/v1/auth/*`, `/v1/service-accounts*` and `/.well-known/jwks.json`, wired in 2c (the registry serves the JWKS itself now).
- **Errors:** `AUTH_INVALID_CREDENTIALS`, `AUTH_RATE_LIMITED`, `AUTH_REFRESH_INVALID`, `AUTH_PASSWORD_POLICY`, `TENANT_SUSPENDED`, `NOT_FOUND`, `FORBIDDEN`.
- **Events:** `registry.service_account.changed`, `registry.auth.refresh_reuse_detected`, `registry.user.changed`.

## 5. Layer placement
| Piece | File |
|---|---|
| Domain | `ServiceAccountKind`, `RefreshTokenStatus`, `Secrets` (random/base64url/sha256) |
| Service | `SigningKeys`, `TokenIssuer`, `AuthService`, `ClientCredentialsService`, `ServiceAccountService`, `Throttle`, `StartupReconciliation` |
| Repository | `SigningKeyRepository`, `RefreshTokenRepository`, `ServiceAccountRepository`, `AuthCacheStore` (Redis) |
| Adapters | `AuthController`, `ServiceAccountController`, `JwksController`, `RegistryStartup` (web-only runner: reads env → services) |

## 6. Security & observability
- Argon2id work is bounded to 2 concurrent operations (64 MiB each). Callers wait in a fair queue for up to 10 s, then get `429 RATE_LIMITED`. This protects the heap from bursts on the unauthenticated actions.
- Never logged, never stored in plaintext, never put in events: refresh tokens, client secrets, passwords, PEMs. Only hashes are stored.
- Emails are hashed in throttle keys.
- Logs: `auth.login.succeeded|failed reason=<category>` with `tenantId`/`userId` when known (never the email), `auth.refresh.reuse_detected`, `service_account.*`, `signing_key.registered kid=`.

## 7. Test plan
| Level | Test | Proves |
|---|---|---|
| Kit unit | `JwksRotationTest` (Java), `jwks-rotation.test.ts`, `test_jwks_rotation.py` | FR-AUTH-05 refetch on unknown kid; previous key still verifies |
| Unit | `SecretsTest`, `TokenIssuerTest` | token formats; claim sets per typ match §2.2 |
| Integration | `AuthIT` | login → claims; 6th failed login → 429; uniform 401s; suspended tenant 403; refresh rotation; reuse → family revoked + event; logout; changePassword keeps the named session only and clears mustChangePassword; role change revokes refresh |
| Integration | `ClientCredentialsIT` | SERVICE token with the exact `act[]`; secret reconcile + 24 h grace (clock); wrong secret 401 → 429; INTEGRATION create/rotate (old valid 24 h, then rejected)/revoke; cross-tenant 404 |
| Integration | `JwksIT` | JWKS shape; rotation drill: new kid current, previous published and accepted ≤ 24 h, then retired |
| Runtime | compose | JWKS served; `svc-gateway` token issued; login as the bootstrap PA |

## 8. Acceptance
- [ ] Unit + integration green; counts in `docs/evidence/phase-02b.md`.
- [ ] Local runtime: `/.well-known/jwks.json`, a SERVICE token for `svc-gateway`, PA login with `mustChangePassword=true`, then a password change.
- [ ] `docs/runbooks/key-rotation.md` (signing key + SERVICE secrets).
