# Runbook — JWT signing key and SERVICE secret rotation (FR-AUTH-05, ADR-0010, ADR-0017)

Values are never pasted into tickets, chat or AI prompts. Every step changes Infisical (or the local `.env`) and restarts pods.

## A. Signing key: every 90 days, or immediately on suspected compromise
The registry signs with `JWT_SIGNING_KEY_CURRENT_PEM` under `JWT_SIGNING_KEY_CURRENT_KID`. At startup it registers that key as `CURRENT` in `registry.signing_keys` and demotes the former key to `PREVIOUS`. The previous key stays in the JWKS for 24 h, so tokens it signed (≤ 15 min lifetime) keep verifying.

1. **Prepare** (environment `E` = dev, then prod). In the operator's MB-03 shell:
   - generate a new RSA-2048 PKCS#8 key: `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`, piped straight into Infisical, never written to disk unencrypted;
   - copy the current `JWT_SIGNING_KEY_CURRENT_PEM` into `JWT_SIGNING_KEY_PREVIOUS_PEM` as the **rollback copy** (the registry does not read it);
   - set `JWT_SIGNING_KEY_CURRENT_PEM` to the new key and `JWT_SIGNING_KEY_CURRENT_KID` to a new id, e.g. `prod-2027-02`. A kid is never reused for different key material, and the registry refuses to start if one is.
2. **Roll out.** The Infisical Operator resyncs `aegispulse-registry-secrets`. Restart the registry Deployment (`kubectl rollout restart`, dev first). Replicas serialize registration with an advisory lock.
3. **Verify.**
   - `curl https://aegispulse-api.<domain>/.well-known/jwks.json` lists the new kid first and the old kid second.
   - A fresh login's access token carries the new `kid`, and calls to every runtime succeed.
4. **Expect.** Verifiers refetch the JWKS on an unknown kid, at most once per 5 s (all three kits). A token with the new kid can get a 401 for up to 5 s after a verifier's previous fetch, and callers retry. The 2026-11-23 local drill at the original 30 s cooldown showed exactly this, which is why the cooldown was cut to 5 s. Tokens signed by the old key keep working until they expire.
5. **After 24 h.** The next registry start marks the old key `RETIRED` and it leaves the JWKS. Delete `JWT_SIGNING_KEY_PREVIOUS_PEM`.
6. **Rollback** (within the window): set `CURRENT_PEM`/`CURRENT_KID` back to the rollback copy and its old kid, then restart. The old kid becomes `CURRENT` again.

**Compromise:** the 24 h publication window must not apply to a compromised key, which has to stop verifying at once. Rotate as above, then:
- set its row to `status = 'RETIRED'` with a reviewed one-off SQL change;
- flush `auth:jwks:cache`;
- revoke all refresh families. Users log in again.

## B. SERVICE client secrets: per runtime, at least yearly or on exposure
Each runtime folder owns `SERVICE_CLIENT_SECRET`. Registry `/registry` holds references to these (`SERVICE_CLIENT_SECRET_{RUNTIME}`), so a change is made **once**.
1. Generate a new value in the runtime's folder, e.g. `/files` (`openssl rand -hex 32`, piped into Infisical).
2. Restart the **registry first**. At startup it finds the value doesn't match the open verifier, inserts a new verifier, and keeps the old one valid for 24 h. The log shows `service_account.secret_reconciled clientId=svc-files`.
3. Restart the runtime. It requests tokens with the new secret.
4. After 24 h the old verifier expires by itself.

On exposure, also rotate the signing key (A), because SERVICE tokens already issued stay valid ≤ 15 min.

## C. INTEGRATION client secrets
These are tenant-owned. A TENANT_ADMIN uses `POST /v1/service-accounts/{id}/rotate-secret`: the new secret is shown once and the previous one is valid for 24 h. To revoke immediately, use `DELETE /v1/service-accounts/{id}`.

## Drill (Phase 2 exit evidence)
`JwksIT.FR_AUTH_05_rotationDrill` and `ClientCredentialsIT.FR_TEN_07_secretReconciliationRotatesInWithA24hGrace` cover the mechanics with a controlled clock. The environment drill is run on dev and recorded in `docs/evidence/phase-02.md`: A.1–A.3 plus a token from the previous key accepted.
