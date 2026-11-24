# Spec — FR-EVT-01..07, FR-CLS-01/02/07 — Events archive and Stage-1 classification (Phase 6)

| | |
|---|---|
| Phase | 06 — Events Archive & Stage-1 Classification (`PROJECT.md` §11). FR-CLS-03..06 (scanner, Stage 2) are Phase 12 |
| Owner runtime(s) | `services/events` (TS/Fastify, MongoDB); gateway `/v1/events*` |
| Status | 6a RUNTIME-VERIFIED locally (2026-11-24); 6b–6d pending |
| Slices | **6a** archive consumer + Stage 1 + finalization + Mongo outbox + source-trust amendment (FR-EVT-01..03, FR-CLS-01/02) · **6b** query APIs (FR-EVT-04..06) · **6c** analyst override (FR-CLS-07) · **6d** retention TTL (FR-EVT-07 part 1) |
| Related | ADR-0004 (outbox), ADR-0008 (elevate-only), ADR-0009; §1.4.2, §1.4.3, §7.6; NFR-02 |

## 1. Requirement
`PROJECT.md` §2.9 FR-EVT-01..07 and §2.10 FR-CLS-01/02/07 (verbatim there). Collections, validators and indexes come from the Phase 1 baseline migration `20261122000001-baseline.cjs` (§7.6); no new Mongo migration is needed for 6a.

## 2. Behavior
### Source trust (amendment, owner-approved 2026-11-24)
- §1.4.3 counts `publisher_stated_severity` only for TRUSTED sources, but trust lives in ingestion.
- The envelope's `classification` gains an optional `source_trust_level` (`TRUSTED|UNTRUSTED`), stamped by the producer at ingest. Ingestion stamps webhook events with the source's `trustLevel`; connectors will do the same.
- Absent means UNTRUSTED. A later trust change does not re-resolve archived events.

### archiveEvent (6a; consumer `events.archive.q`, bound `#` on all four exchanges)
1. **Envelope validation:** done by the kit consumer (`parseEnvelope`): non-JSON or schema-invalid → `PoisonMessageError ENVELOPE_INVALID` → DLQ immediately, no retry tiers (FR-EVT-01).
2. **Replay:** a delivery with `x-aegis-replay-job` only bumps `replay.count`, `lastReplayedAt` and `lastJobId` on the archived record (either tier). It never creates a record and logs a warning when the event is unknown (FR-EVT-02).
3. **Stage 1** (`domain/classification/rules-v1.ts`, `rules-v1.0.0`, synchronous; histogram `aegispulse_classification_stage1_seconds`):
   - The baseline table (§1.4.2), including terminal families (`classification.*`, `intel.*`, `ops.*`, `registry.*`, `correlation.*`, `notification.*`): INTERNAL/INFO, never Stage 2, never emit.
   - **Clarifications:**
     - `doc.extraction.completed` and `doc.extraction.review_required` share a row. Red flags 0 → LOW, 1–2 → MEDIUM, ≥ 3 → HIGH; Stage 2 when `textExcerpt` is non-empty.
     - `risk.evaluation.recorded` takes the payload `band`.
     - `case.*` takes the payload `severity` (default MEDIUM).
   - **Detectors** (elevate-only), with values masked in the stored payload and listed as `redactions[{path, rule, kind: MASK}]` (dotted paths with `[n]`):
     - Secrets → RESTRICTED, SECRET, ≥ HIGH: AWS key, PEM private-key header, Slack token, generic `api_key|secret|password` assignment with a value of 16+ characters, and fields named like those.
     - Luhn-valid 13–19-digit cards → last 4. US SSNs (excluding area 000/666/9xx and group 00/serial 0000) → `***-**-NNNN`. RESTRICTED, PII; PII raises sensitivity, not severity.
     - PII-named keys `ssn, dob, taxId, passportNumber, accountNumber` (string or number) → last 4. RESTRICTED, PII.
     - MNPI lexicon → MNPI, ≥ CONFIDENTIAL, ≥ HIGH (not masked).
   - `payloadSha256` is the SHA-256 of the pre-redaction payload (`JSON.stringify`).
4. **Tier:** RESTRICTED → `events_restricted_audit`, otherwise `events_archive`.
5. **Resolution** (`severity-resolver.ts`, §1.4.3, pure):
   - `algorithm = max(rule, ai if confidence ≥ 0.60)`.
   - `final = max(algorithm, publisher)` only when TRUSTED.
   - An override wins.
   - Before Stage 2 there is no AI result, so `final` is the rule resolution (FR-CLS-06 "never blocked").
6. **Expiry:** `archivedAt + tenant retentionDays` (registry `getTenantSettings`, kit cache), or `archivedAt + 7 years` for the restricted tier. Tenantless envelopes and the reserved platform tenant use the default 400 days, and so does a tenant unknown to the registry (with a warning). A registry outage → TransientError → retry tiers.
7. **One Mongo transaction:**
   - Insert the record: classification `{sensitivity, categories, publisher_stated_severity (verbatim), source_trust_level, algorithm_severity, algorithm_confidence null, final_severity, classification_source RULES, rule_version, classifier_version null, revision 1}`, `statusHistory` INGESTED → RULE_SCANNED (→ CLASSIFIED), `classificationHistory[RULES]`, `mentionedEntityIds []` (entity resolution arrives with correlation), and `replay {0, null, null}`.
   - Non-terminal types, no Stage 2 → status CLASSIFIED and outbox `classification.finalized`.
   - Non-terminal types, Stage 2 needed → status RULE_SCANNED, `pendingAiScan: true`, outbox `classification.scan.requested {eventId, revision}`. The consumer and scanner arrive in Phase 12.
   - A duplicate `{tenantId, eventId}` in either tier aborts the transaction → ack as a duplicate (FR-EVT-02).
8. **Outbox events** go on `aegispulse.enrichment` with `causationId` = the archived event id and the same correlationId. They carry the classification and entity mentions, never payload bodies.

### Mongo outbox (6a; `outbox` collection, §7.6)
`MongoOutboxRelay` atomically claims one due entry at a time with `findOneAndUpdate`: PENDING and due, or SENDING with a lapsed 30 s lease. It publishes through the kit `AmqpPublisher` (publisher confirms) and then marks SENT (TTL 7 d). A failure → PENDING with backoff `min(60 s, 2^attempts s)`, and the pass stops. Gauge `aegispulse_outbox_lag_seconds{store="mongo"}`.

## 3. Tests
| Level | Test | Proves |
|---|---|---|
| Unit | `rules-v1.test.ts` | every baseline row incl. terminal families; secret/card/SSN/PII-key masking goldens with paths; MNPI; no false positives on uuids/hex/dates; p95 ≤ 5 ms over 2,000 runs |
| Unit | `severity-resolver.test.ts` | exhaustive elevate-only (5×6×4×6×2 = 1,440 combinations): never below rule, final ≥ algorithm, AI only at ≥ 0.60, publisher only when TRUSTED; override wins |
| Unit | `retention.test.ts`, `tenant-retention.test.ts` | 400/30-day and 7-year expiry; platform/tenantless/unknown → default without failing; registry outage propagates |
| Integration (Testcontainers Mongo 8 replica set + RabbitMQ 4, contract topology) | `archive.integration.test.ts` | 3× redelivery → 1 document; Stage 2 path + scan.requested relayed once; trusted vs untrusted publisher; terminal type emits nothing; RESTRICTED → restricted tier with masked payload, redactions, pre-redaction sha256, 7-year expiry; tenant retention; replay header updates only (never creates); non-JSON and schema-invalid → DLQ `ENVELOPE_INVALID`, retry count 0 |
