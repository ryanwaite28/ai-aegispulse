# Spec — FR-WHK-01..05, 07, 08 — Webhook ingestion (Phase 4)

| | |
|---|---|
| Phase | 04 — Webhook Ingestion (`PROJECT.md` §11). FR-WHK-06 attachments is Phase 11 |
| Owner runtime(s) | `services/ingestion` (TS/Fastify); gateway `POST /webhooks/:sourceKey`, `/v1/webhook-sources*` |
| Status | 4a INTEGRATION-VERIFIED (2026-11-24); 4b, 4c pending |
| Slices | **4a** source management + secret crypto · **4b** signature verification, delivery persistence, outbox → `aegispulse.ingress`, gateway webhook route, adversarial suite · **4c** secret expiry + orphan sweep + scheduler trigger |
| Related | ADR-0002, ADR-0004 (outbox), ADR-0009 (pointers only), ADR-0010, ADR-0016 (definer lookups); NFR-02, NFR-06, NFR-08 |

## 1. Requirement
`PROJECT.md` §2.4 FR-WHK-01..08 (verbatim there). Migrations are **V3/V4**: V2 is ADR-0016's `enforced_rls_bypass`, so the plan's V2/V3 move up by one (clarification, as for Phase 2/3).

## 2. Behavior
### Secrets at rest (FR-WHK-01; `src/domain/crypto.ts`)
- The signing secret is 32 random bytes, base64url, returned once.
- **Envelope encryption:**
  - A fresh 256-bit data key per secret row seals the secret with AES-256-GCM: a 12-byte `nonce`, and `ciphertext` = encrypted secret ‖ 16-byte tag.
  - The data key is wrapped with **AES-256 Key Wrap** (RFC 3394, `id-aes256-wrap`) under the KEK. Key wrap needs no nonce, which is why the §7.2 DDL has a single `nonce` column.
  - The row also stores `kek_version` (`INGESTION_KEK_VERSION`).
- **KEK:** `INGESTION_KEK_BASE64` must decode to exactly 32 bytes, otherwise startup fails and the error names the variable. A row with a `kek_version` the process does not hold is a 500 (`INTERNAL_ERROR`), never a silent pass.
- Secrets are never logged, put in events, or returned after creation or rotation.

### Source management (FR-WHK-01/07): TENANT_ADMIN of its own tenant (contract roles; no X-Aegis-Tenant)
- **create:**
  - The `sourceKey` is unique across all tenants → `409 WEBHOOK_SOURCE_KEY_TAKEN`, including keys of soft-deleted sources: a public URL is never re-issued to another tenant.
  - Defaults: `UNTRUSTED`, `AEGIS_MARKET_EVENT_V1`, `allowedAttachmentHosts = []` (hostnames lower-cased, no scheme/path).
  - Stores the CURRENT secret.
  - Returns `WebhookSourceWithSecret`, 201.
  - `Idempotency-Key` de-duplicates but never replays the one-time secret (409, as FR-TEN-06).
- **list:** keyset `(created_at, id)`; excludes deleted sources.
- **update:**
  - Changes `displayName`, `status`, `trustLevel` and `allowedAttachmentHosts`.
  - A trust-level change emits `ops.audit.source_trust_changed {sourceId, sourceKey, before, after, actorId}` (exchange `aegispulse.intelligence`) through the outbox.
- **rotate:** the CURRENT secret becomes PREVIOUS (`expires_at = now + 72 h`, replacing any PREVIOUS), and a new CURRENT is generated and returned once (`WebhookSecretRotation`).
- **delete:** soft delete (`deleted_at`). The source stops accepting deliveries (404) and leaves lists.
- **listDeliveries** (4b): metadata only, never the raw body.

### Ingest (FR-WHK-02..05; 4b)
- The gateway reads the raw request bytes (Nest `rawBody`, 1 MiB route limit) and forwards them unparsed, as `ingestWebhookDelivery{sourceKey, headers, rawBodyBase64, receivedAt, clientIp}`, with its SERVICE token.
- **IngestWebhookUseCase**, in this order. A failure at any step → that code, the `aegispulse_webhook_rejected_total{source,reason}` metric, and a log line without the body:
  1. Look up the source by key: SECURITY DEFINER `ingestion.webhook_source_for_delivery(key)` (pre-tenant, ADR-0016). Unknown, deleted or DISABLED → `404 WEBHOOK_SOURCE_NOT_FOUND`.
  2. Tenant status (registry `getTenantSettings`, kit 60 s cache): not ACTIVE → `403 TENANT_SUSPENDED`.
  3. Signature (`src/domain/signature.ts`):
     - The header holds `v1=<64 hex>`, comma-separated, at most 5 entries; anything malformed or absent → `401 WEBHOOK_SIGNATURE_INVALID`. Missing timestamp or delivery id → also 401 `WEBHOOK_SIGNATURE_INVALID`.
     - The signed string is `{timestamp}.{deliveryId}.{rawBytes}`, and the HMAC-SHA256 is computed against CURRENT and then PREVIOUS (the latter while unexpired).
     - Comparison uses `crypto.timingSafeEqual` on equal-length 32-byte buffers, and **every candidate × secret pair is compared** (no early exit).
     - Records which slot matched.
  4. Skew: `|now − timestamp| > 300 s` → `401 WEBHOOK_TIMESTAMP_SKEW`. It is checked after the signature, so an attacker can't probe skew without a valid signature.
  5. Replay: Redis `SET whk:nonce:{sourceId}:{deliveryId} NX EX 900`. Taken → `409 WEBHOOK_REPLAY_DETECTED`. The durable unique `(source_id, delivery_id)` also maps to 409.
  6. Payload: parse JSON and validate against the `AEGIS_MARKET_EVENT_V1` contract schema (Ajv) → `422 VALIDATION_ERROR` (only after the signature).
  7. Raw object PUT to `raw/webhooks/{tenantId}/{yyyy}/{mm}/{dd}/{deliveryUuid}.json`, **before** the transaction (orphans are swept in 4c).
  8. One tenant transaction (RLS): insert `webhook_deliveries`. On `ux_deliveries_accepted_idem` conflict, insert outcome `DUPLICATE` with no outbox and return `duplicate: true`. Otherwise insert the canonical envelope into `outbox_events`.
  9. → `202 {deliveryId, eventId|null, duplicate}`.
- **Envelope** (`src/domain/envelope-builder.ts`):
  - `eventId` UUIDv7; `eventType` from the category map (FR-WHK-05); `correlationId` from the request or minted.
  - `idempotencyKey = {sourceKey}:{externalId}:v{version}`; `source = webhook:{sourceKey}`; `producer aegispulse-ingestion@{sha}`.
  - `classification {sensitivity: UNCLASSIFIED, status: INGESTED, classification_source: PRODUCER, publisher_stated_severity: payload.severity?}`.
  - The payload carries the fields of the canonical event schema for that type. Binaries never: `attachments` stay URLs (ADR-0009).
- The outbox relay publishes to `aegispulse.ingress` with publisher confirms.

### Expiry and sweep (FR-WHK-08; 4c)
`expirePreviousSecrets` (scheduler-trigger SERVICE token, hourly CronJob `ingestion-secret-expiry`):
- deletes PREVIOUS secrets past `expires_at` (definer function, cross-tenant);
- deletes raw objects under `raw/webhooks/` older than 1 h that have no delivery row;
- returns a `JobRunSummary`.

## 3. Data
- **`V3__webhook_sources.sql`:** `webhook_sources` and `webhook_secrets` (§7.2) under RLS, plus the definer functions `webhook_source_key_taken(text)` and `webhook_source_for_delivery(text)`.
- **`V4__webhook_deliveries.sql`** (4b): `webhook_deliveries` (§7.2) under RLS.

## 4. Tests
| Level | Test | Proves |
|---|---|---|
| Unit | `crypto.test.ts` | seal/open round-trip; tamper (ciphertext, tag, wrapped key, nonce) fails; wrong KEK fails; KEK length enforced |
| Unit | `signature.test.ts` | canonical string; multi-signature parsing; malformed → invalid; all pairs compared (timingSafeEqual spy) |
| Unit | config | missing / short KEK → startup config error naming the variable |
| Integration (Testcontainers PG+Redis+RabbitMQ+SeaweedFS) | `webhook-sources.integration.test.ts` | create/dup 409 (incl. other tenant), secret once, rotate keeps previous 72 h (clock), trust change audit event, delete, RLS isolation |
| Integration | `ingest.integration.test.ts` (4b) | 202 → envelope on a test queue bound to `external.#` exactly once across relay restarts; duplicate externalId → `duplicate: true`, no event |
| Security | `tests/security/webhooks.spec.ts` (4b) | adversarial: wrong secret, truncated signature, skew ±301 s, replayed id, oversize, malformed JSON, missing headers → codes |
| Integration | expiry/sweep (4c) | clock-controlled expiry; orphan deleted, referenced object kept |
