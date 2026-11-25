# AegisPulse — Distributed Risk, Regulatory & Market Intelligence Platform

**Project Master Document v1.0**

> **This document is the single source of truth for AegisPulse.** Every architectural decision, data model, API contract, messaging contract, infrastructure configuration, business rule, and implementation plan lives here. AI coding assistants (Claude Code, Cursor, Copilot, Codex) must generate specifications, implementation tasks, and code directly from this document. If something is not specified here, it is not decided — propose an amendment (see §12.15) instead of inventing a pattern. Project decisions must not be stored anywhere else; ADRs in `docs/adr/` record the *rationale* for decisions captured here.

| | |
|---|---|
| **Author** | Ryan M. Waite — Systems Architect & Principal Software Engineer |
| **Source concept** | [docs/AEGIS_PULSE.md](docs/AEGIS_PULSE.md) |
| **Deployment context** | [docs/K3S_CONTEXT.md](docs/K3S_CONTEXT.md) (homelab k3s + self-hosted GitLab) |
| **Messaging library** | [docs/libs/RXJS_RABBITMQ.md](docs/libs/RXJS_RABBITMQ.md) (`rxjs-rabbitmq`) |
| **Authoring guide** | [docs/PROJECT_TEMPLATE_GUIDE.md](docs/PROJECT_TEMPLATE_GUIDE.md) |
| **Document status** | v1.0 — baseline, all requirements `PENDING` |
| **Last updated** | 2026-11-24 (Phase 8: `fx-static-v1` as contract reference file; Phase 7: §7.6 `dead_letters` registry fields, FR-MSG-03 replay path, §6.5 raw consumer; DLQ headers `x-aegis-error-message`/`-stack-hash`, `ops.audit.dead_letter_resolved`; envelope `classification.source_trust_level` for §1.4.3; `ops.audit.file_deleted` for FR-FILE-12 / FR-AUD-02; §5.1 CronJob `aegispulse-cron-secret-expiry`, 9 CronJobs; §5.7.3 ingestion object-store list grant for FR-WHK-08) · 2026-11-23 (JVM heap 50%; ADR-0017 SERVICE secret reconciliation; client-credentials rate limit; JWKS source; changePassword session keep; `registry.tenant.deactivated`; FR-TEN-09) |

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Functional Requirements](#2-functional-requirements)
3. [Non-Functional Requirements](#3-non-functional-requirements)
4. [System Architecture](#4-system-architecture)
5. [Infrastructure & Resources (Homelab k3s + Reference AWS)](#5-infrastructure--resources-homelab-k3s--reference-aws)
6. [Software Design](#6-software-design)
7. [Data Model](#7-data-model)
8. [API Documentation](#8-api-documentation)
9. [DevOps & Deployment](#9-devops--deployment)
10. [Local Development](#10-local-development)
11. [Implementation Plan](#11-implementation-plan)
12. [Project Rules & AI-IDE Guidelines](#12-project-rules--ai-ide-guidelines)
13. [Infrastructure Cost Estimates](#13-infrastructure-cost-estimates)
14. [Testing Plan](#14-testing-plan)
- [Appendix A — Source Reconciliation & Template Adaptations](#appendix-a--source-reconciliation--template-adaptations)
- [Appendix B — Glossary](#appendix-b--glossary)

---

## 1. Project Overview

### 1.1 What Is AegisPulse?

> **Portfolio note (honest scope):** AegisPulse is a portfolio-grade reference implementation built and operated by one engineer on a two-node homelab Kubernetes cluster. It demonstrates production *patterns* — polyglot microservices, event-driven resilience, data governance, and a full DevSecOps toolchain — at deliberately small scale. It does not ingest real customer financial data, it is not certified for any regulatory regime, and its "AI" components run CPU-only models trained on synthetic/golden datasets. Production-scale topology is documented (§4.2, §5.8, §13.2) but not provisioned.

AegisPulse is a **multi-tenant, event-driven risk and market-intelligence platform**. It ingests two very different kinds of signals — high-velocity **transaction/activity events** and unstructured **regulatory and market signals** (new regulations, IPO filings, M&A announcements, compliance disclosures, ad-hoc document uploads) — then classifies, scores, correlates, archives, and analyzes them so that analysts get a single, auditable stream of risk cases.

The platform is organized into four planes:

1. **Real-Time Event & Risk Anomaly Plane** — transaction intake, feature enrichment, heuristic/ML risk scoring, and stateful risk-case workflows.
2. **Document, Filing & Ad-Hoc File Intelligence Plane** — verified webhooks, connector pollers, presigned file uploads, safe file lifecycle outside the broker, document ETL, and entity/clause extraction.
3. **Event Audit, Classification & Provenance Plane (Events Service)** — an authoritative MongoDB archive of every routed event with `sensitivity` metadata and severity lineage (`publisher_stated_severity` → `algorithm_severity` → `final_severity`) plus lifecycle `status`, enabling audit, replay, and classifier evaluation.
4. **Data Intelligence & Feedback Plane** — analytical rollups, drift and quality monitoring, golden-dataset evaluation, and analyst disposition feedback.

### 1.2 How It Works

```
EXTERNAL PUBLISHER (regulator relay, filing feed, market-alert vendor)
  → POST /webhooks/{sourceKey} with HMAC-SHA256 signature, timestamp, delivery id
  → [gateway/nest-http] forwards raw bytes + headers to Ingestion Service
  → [Ingestion] verifies signature (constant-time, dual-key), timestamp skew ±5 min,
     Redis nonce (deliveryId) + durable idempotency (sourceKey:externalId:vN)
      ├─ invalid signature / skew / replay → 401/409, metric webhook_rejected_total{reason}
      ├─ duplicate externalId              → 202 {duplicate:true}, no new event
      └─ valid → raw payload → object storage; delivery + outbox row in one txn → 202 Accepted
  → Outbox relay publishes canonical envelope `external.<category>` → aegispulse.ingress

CONNECTOR POLLER (CronJob, every 15 min)
  → [workers/scheduler-trigger] POST ingestion /internal/v1/connectors:run-due
  → [Ingestion] fetches RSS/Atom/filing APIs (SSRF-guarded), normalizes each item into the
     SAME canonical contract as webhooks → same idempotency + outbox path

ANALYST / INTEGRATION CLIENT
  → Authenticates (JWT from Registry) → console or REST via gateway
  → Submits transactions (POST /v1/transactions) → Ingestion → outbox → `txn.submitted`
  → Uploads files: init → presigned PUT to object storage → complete
      → [Files] UPLOADED → `file.uploaded` → validation (size, SHA-256, magic bytes, AV)
          ├─ VALIDATED → `doc.file.ready` → [Doc Extraction] parse/OCR/NER/clauses
          │     ├─ confidence ≥ 0.70 → Files records result → PROCESSED → `doc.extraction.completed`
          │     └─ confidence < 0.70 → `doc.extraction.review_required` → EXTRACTION_REVIEW case
          ├─ AV hit / MIME mismatch → QUARANTINED → `notification.requested`
          └─ checksum/size mismatch → FAILED

EVERY ROUTED EVENT (all four topic exchanges, binding `#`)
  → [Events Service] archive consumer: idempotent insert on (tenantId, eventId)
  → Stage 1 deterministic rules: sensitivity tag, rule severity, secret/PII redaction → RULE_SCANNED
      ├─ structured + classified → CLASSIFIED → `classification.finalized`
      └─ unstructured / UNCLASSIFIED → `classification.scan.requested`
            → [Events] calls Sensitivity Scanner (async, circuit-breaker)
            → AI_SCANNED → resolve final_severity (elevate-only) → CLASSIFIED → `classification.finalized`
  → RESTRICTED sensitivity → stored in `events_restricted_audit` (auditor-only, 7-year TTL)

ORCHESTRATION SAGAS (services/orchestrator, stateless, idempotent steps)
  → `txn.submitted`: watchlist check (Registry) → score (Risk Scoring) → Cases.recordRiskEvaluation
      ├─ score < 70 → evaluation recorded, no case
      └─ score ≥ 70 → case OPEN → ENRICHING → POLICY_EVALUATED → ESCALATED | CLEARED
  → `classification.finalized` (external/doc events, final ≥ HIGH): resolve mentioned entities
      → Cases.reevaluateOpenCases(entities) and/or open DOCUMENT_RISK case on watchlist hit
  → `correlation.requested` (case escalated ≥ HIGH): search Events archive for recent
      filings/news on the entity → Cases.attachEvidence → policy re-run
  → `notification.requested`: render template → ntfy push

ANALYST
  → Works cases in console (SSE live updates), records disposition
      (TRUE_POSITIVE | FALSE_POSITIVE | NEEDS_REVIEW) → immutable hash-chained audit entry
  → `case.disposition.recorded` → [Data Intel] precision per model/rule version

DATA INTELLIGENCE (micro-batch 15 min, nightly 02:00 UTC)
  → rollups (latency, entity risk trajectories, source reliability, exposure)
  → drift (PSI on score distributions, extraction confidence, publisher-vs-algorithm disagreement)
      └─ threshold breach → `intel.drift.detected` → notification
  → golden-dataset evaluation runs gate Python model changes in CI

OPERATOR
  → Replays historical events by correlationId / eventType / time window (POST /v1/events/replay)
  → Inspects and replays dead letters (GET/POST /v1/ops/dead-letters)
```

### 1.3 Key Entities

| Entity | Description |
|---|---|
| **Tenant** | Isolation boundary. Every row, document, object key, cache key, and event carries `tenantId`. States: `ACTIVE`, `SUSPENDED`, `DEACTIVATED`. |
| **User** | Human principal inside a tenant with one or more roles (§1.4.6). Authenticates with email + password (Argon2id) → JWT. |
| **Service Account** | Non-human principal (role `INTEGRATION` or internal `SERVICE`) authenticating with client credentials. |
| **Tracked Entity** | A monitored organization, ticker, counterparty, agency, or executive with aliases. |
| **Watchlist** | Named, tenant-scoped set of tracked entities with a watch reason and severity floor. |
| **Webhook Source** | A registered external publisher (`sourceKey`) with HMAC secrets (current + previous), trust level, and payload mapping. |
| **Connector** | A polled feed (RSS/Atom/filing API) with schedule, cursor, allowlisted host, and mapping. |
| **Webhook Delivery** | A verified inbound webhook request (raw payload pointer, delivery id, verification outcome). |
| **Transaction Submission** | An inbound transaction/activity event accepted for scoring. |
| **File** | A binary managed by the Files Service (`INITIATED → UPLOADED → VALIDATED → PROCESSING → PROCESSED / FAILED / QUARANTINED / EXPIRED`). Never carried on the broker. |
| **Extraction Artifact** | Text, chunks, entities, clauses, and classification output derived from a file, stored in object storage and referenced by key. |
| **Canonical Event (Envelope)** | Versioned message contract (§6.4) shared by every producer and consumer. |
| **Archived Event** | MongoDB record of a canonical event with classification block, lineage history, status history, redactions, and replay info. |
| **Risk Evaluation** | Score result for one transaction: score 0–100, band, contributing factors, model version. |
| **Risk Case** | Stateful workflow object (`OPEN → ENRICHING → POLICY_EVALUATED → ESCALATED / CLEARED → RESOLVED`) of type `TRANSACTION_RISK`, `DOCUMENT_RISK`, `EXTRACTION_REVIEW`, or `CORRELATED`. |
| **Case Evidence** | Link from a case to an event, file, extraction, or evaluation that contributed to its policy score. |
| **Disposition** | Analyst verdict: `TRUE_POSITIVE`, `FALSE_POSITIVE`, `NEEDS_REVIEW`. |
| **Audit Entry** | Immutable, per-tenant hash-chained compliance record of a state change, including the triggering event/file and model/rule version. |
| **Replay Job** | Controlled republish of archived events with filters, limits, and progress. |
| **Dead Letter** | Message that exhausted retries or was rejected as poison, captured with full error metadata. |
| **Drift Metric / Eval Run** | Data-intelligence measurements of model/rule quality over time. |

### 1.4 Domain-Specific Logic (Deterministic Rules)

All rules below are deterministic so tests and demos are reproducible. Versioned identifiers (`rule_version`, `model_version`) are recorded wherever a rule influences an outcome.

#### 1.4.1 Severity and Sensitivity Scales

| Severity | Rank | | Sensitivity | Meaning |
|---|---|---|---|---|
| `INFO` | 0 | | `PUBLIC` | Publicly available information |
| `LOW` | 1 | | `INTERNAL` | Platform-internal metadata |
| `MEDIUM` | 2 | | `CONFIDENTIAL` | Tenant business data, filings under analysis |
| `HIGH` | 3 | | `RESTRICTED` | PII, MNPI, secrets — auditor-only isolated storage |
| `CRITICAL` | 4 | | `UNCLASSIFIED` | Not yet determined; triggers Stage 2 AI scan |

Sensitivity categories: `PII`, `MNPI`, `REGULATORY`, `FINANCIAL`, `SECRET`.

#### 1.4.2 Stage 1 Rule Classification (`rules-v1.0.0`)

Baseline by event type (applied at archive time):

| Event type pattern | Base sensitivity | Base severity | Needs Stage 2? |
|---|---|---|---|
| `external.regulatory.published` | CONFIDENTIAL | MEDIUM | yes (unstructured title/body) |
| `external.ipo.filed` | CONFIDENTIAL | MEDIUM | yes |
| `external.acquisition.announced` | CONFIDENTIAL | HIGH | yes |
| `external.market.alert` | CONFIDENTIAL | MEDIUM | yes |
| `external.compliance.disclosed` | CONFIDENTIAL | HIGH | yes |
| `txn.submitted` | CONFIDENTIAL | LOW | no |
| `file.*`, `doc.file.ready` | INTERNAL | INFO | no |
| `doc.extraction.completed` | CONFIDENTIAL | from extraction red-flags | yes if `textExcerpt` present |
| `risk.evaluation.recorded`, `case.*` | CONFIDENTIAL | from score band / case severity | no |
| `classification.*`, `intel.*`, `ops.*`, `registry.*`, `correlation.*`, `notification.*` | INTERNAL | INFO | **never** (prevents scan loops) |
| anything else | UNCLASSIFIED | LOW | yes |

Elevation rules (each may only raise, never lower):
- Payload contains a detected secret (AWS key `AKIA[0-9A-Z]{16}`, PEM private key header, `xox[baprs]-` token, generic `(?i)(api[_-]?key|secret|password)\s*[:=]` with ≥16-char value) → sensitivity `RESTRICTED`, category `SECRET`, severity ≥ `HIGH`, value **masked** before persistence.
- Payload contains a payment card number (13–19 digits passing Luhn) or US SSN (`\b\d{3}-\d{2}-\d{4}\b`, excluding `000`, `666`, `9xx` area) → `RESTRICTED`, category `PII`, masked to last 4.
- Keys named `ssn`, `dob`, `taxId`, `passportNumber`, `accountNumber` → `RESTRICTED`, `PII`, masked.
- Text matching MNPI lexicon (`material non-public`, `embargoed until`, `not for distribution`, `pre-announcement`) → category `MNPI`, sensitivity ≥ `CONFIDENTIAL`, severity ≥ `HIGH`.

#### 1.4.3 Final Severity Resolution (`severity-resolver-v1`, ADR-0008)

```
rule_sev      = Stage 1 result (always present)
ai_sev        = Stage 2 result (present only if scanned) with confidence c
publisher_sev = publisher_stated_severity (may be null)

algorithm_severity = max(rule_sev, ai_sev)   if ai_sev present and c ≥ 0.60
                   = rule_sev                otherwise (classification_source = RULES)

final_severity     = max(algorithm_severity, publisher_sev)  if classification.source_trust_level = TRUSTED
                   = algorithm_severity                      otherwise
final_severity     = analyst override value                  if an override exists (OVERRIDDEN)
```
- Resolution is **elevate-only** for automated stages. Only an analyst with `ANALYST`+ role may lower severity, with a mandatory justification (≥ 20 chars) that is audited.
- `classification.source_trust_level` is the source's trust level at ingest time, stamped by the producer (ingestion, for webhook and connector events); absent means `UNTRUSTED`. A later trust change does not re-resolve archived events.
- `publisher_stated_severity` is preserved verbatim and never mutated; disagreement (`publisher_sev ≠ algorithm_severity`) is a tracked data-intelligence metric.

#### 1.4.4 Transaction Risk Score (`risk-heuristic-v1.0.0`, Phase 8; ML model in Phase 12)

```
amount_factor        = min(40, 40 × amount_in_usd / tenant.high_value_threshold_usd)   (default threshold 50,000)
velocity_factor      = min(25, 5 × max(0, txn_count_1h(accountId) − 3))
geo_factor           = 15 if country ∈ tenant.high_risk_countries (default list: config HIGH_RISK_COUNTRIES)
watchlist_factor     = 20 if counterparty resolves to an entity on any ACTIVE tenant watchlist
new_counterparty     = 10 if (accountId, counterpartyId) not seen in the last 30 days
score                = min(100, sum of factors)            (integer)
band                 = LOW <40 | MEDIUM 40–69 | HIGH 70–84 | CRITICAL ≥85
case_threshold       = 70  → opens TRANSACTION_RISK case
```
- Currency conversion uses a static, versioned FX table (`fx-static-v1`) — no live FX calls. It is a contract reference file, `packages/contracts/reference/fx-static-v1.json` (`{version, base: USD, asOf, usdPerUnit{ccy: decimal string}}`, schema-validated by `make contracts`). Ingestion reads it for the FR-TXN-01 currency check and risk-scoring for USD amounts; a new version is a new file.
- Velocity/new-counterparty features are kept in Risk Scoring's Redis keyspace (sorted sets, 30-day TTL).
- **Demo override (demo-mode tenants only, any environment):** `metadata.demoScenario = "FORCE_CRITICAL"` adds a 100-point factor named `demo_override`. Ignored unless `tenant.demo_mode = true`.
- Phase 12 adds an IsolationForest anomaly model (`risk-iforest-vN`); final score = `max(heuristic, round(100 × anomaly_score))`, both factor sets returned for explainability.

#### 1.4.5 Case Policy Evaluation (`policy-v1.0.0`)

```
policy_score = base_score                                  (risk score for TRANSACTION_RISK; 50 for DOCUMENT_RISK; 0 otherwise)
             + min(30, 15 × count(correlated evidence with final_severity = HIGH))
             + 25 if any correlated evidence has final_severity = CRITICAL
             + 20 if watchlist hit and not already counted in base_score
             + min(30, 10 × count(extraction red-flag clauses))
policy_score = min(100, policy_score)
outcome      = ESCALATED if policy_score ≥ 75 else CLEARED
case.severity = band(policy_score) using §1.4.4 bands
```
Red-flag clause lexicon (`clauses-v1`): *material weakness, going concern, restatement, consent order, cease and desist, sanctions, subpoena, wells notice, delisting, default, covenant breach, investigation*.

#### 1.4.6 Roles and Permissions

| Role | Scope | Key permissions |
|---|---|---|
| `PLATFORM_ADMIN` | global | create/suspend tenants, global ops (DLQ, replay across tenants) |
| `TENANT_ADMIN` | tenant | users, service accounts, webhook sources, connectors, watchlists, tenant replay |
| `ANALYST` | tenant | read events/files/cases, work cases, dispositions, classification overrides, uploads |
| `VIEWER` | tenant | read-only cases, events (non-RESTRICTED), files metadata, dashboards |
| `COMPLIANCE_AUDITOR` | tenant | read audit log, verify chain, read `events_restricted_audit` |
| `INTEGRATION` | tenant (service account) | submit transactions, upload files, read own submissions |
| `SERVICE` | internal (service account) | internal `/internal/v1/*` APIs per allowlist (§5.7) |

#### 1.4.7 Mock & Synthetic Data Strategy

- Seed tenants: `tenant-acme-capital` (demo_mode on), `tenant-globex-bank` (demo_mode off) for isolation tests.
- Seed entities: ACME Holdings (`ACMH`), Globex Clearing (`GLBX`), Initech Securities, Umbrella Pharma (`UMBR`), Stark Analytics; watchlist "Sanctions Watch" containing Globex Clearing.
- `scripts/demo/` generates signed webhooks for each category, transaction streams (normal + anomalous bursts), and sample PDFs/CSVs from `eval/golden/`.
- All synthetic entity names are fictional.

### 1.5 Project Identity

| Field | Value |
|---|---|
| Project name | AegisPulse |
| Repository | `aegispulse` monorepo on self-hosted GitLab (`gitlab.rmwhs.com`) |
| Domain | Risk, regulatory & market intelligence (FinTech / RegTech) |
| Console URL (prod) | `https://aegispulse.rmwhs.com` |
| API URL (prod) | `https://aegispulse-api.rmwhs.com` |
| Object upload URL (prod) | `https://aegispulse-objects.rmwhs.com` (presigned S3 only) |
| Console URL (dev) | `https://aegispulse.rmwhs-dev.space` |
| API URL (dev) | `https://aegispulse-api.rmwhs-dev.space` |
| Object upload URL (dev) | `https://aegispulse-objects.rmwhs-dev.space` (presigned S3 only) |
| Domains | `rmwhs.com` = **prod**, `rmwhs-dev.space` = **dev**; both proxied by Cloudflare to the same tunnel → same k3s cluster (ADR-0014) |
| Local URLs | gateway `http://localhost:8080`, console `http://localhost:5173`, objects `http://localhost:9000` |
| Kubernetes cluster | homelab k3s, 3 nodes (ADR-0015): `elitedesk-800` (control plane + shared platform + spill-over compute), `optiplex` (app-compute worker), `optiplex-tower` (storage-dedicated, 1 TB data SSD) |
| Kubernetes namespaces | `aegispulse` (prod), `aegispulse-dev` (dev) |
| Container registry | `registry.rmwhs.com/<group>/aegispulse/<image>` (`$CI_REGISTRY_IMAGE`) |
| Environments | `local` (Docker Compose), `dev` (homelab k3s, `*.rmwhs-dev.space`), `prod` (homelab k3s, `*.rmwhs.com`, the portfolio deployment); AWS production is a documented reference architecture only |
| Resource prefix | `aegispulse-` (Kubernetes), `aegispulse.` (RabbitMQ exchanges), `aegispulse-<env>-` (buckets) |
| RabbitMQ | shared cluster broker (`rabbitmq` namespace), vhosts `aegispulse-dev` and `aegispulse-prod` |
| Secrets | Infisical (`infisical.rmwhs.com`), org **HomeLab**, project **AegisPulse** (`16d178ac-eebb-4295-9243-b52b04ff3286`), environments **Development** (→ `aegispulse-dev`) and **Production** (→ `aegispulse`); local secrets are generated, never in Infisical ([runbook](docs/runbooks/infisical.md), ADR-0012) |
| Observability | OpenObserve (`openobserve.rmwhs.com`), stream prefixes `aegispulse_dev_` / `aegispulse_prod_` |
| Notifications | ntfy topics `aegispulse-alerts` (prod) and `aegispulse-alerts-dev` (dev), access-token protected |
| Cloud account | None for portfolio (homelab). Reference production targets AWS (§5.8). |

### 1.6 Mission

Demonstrate principal-level systems architecture and engineering by delivering a polyglot (TypeScript, Java, Python), event-driven, multi-tenant platform with verifiable idempotency, data-governance lineage, zero-trust security, and a complete shift-left DevSecOps pipeline running on real Kubernetes.

---

## 2. Functional Requirements

### 2.0 Conventions

- IDs: `FR-{DOMAIN}-{NN}`. Domains: `TEN` (tenancy & identity), `AUTH`, `ENT` (entities & watchlists), `WHK` (webhooks), `CON` (connectors), `TXN` (transactions & scoring), `FILE`, `DOC` (document extraction), `EVT` (event archive), `CLS` (classification), `RPL` (replay), `CASE`, `AUD` (audit), `COR` (correlation), `MSG` (messaging resilience & dead letters), `SSE`, `NOTIF`, `INTEL`, `EVAL`, `FE` (console), `DEMO`.
- "Owner" names the service runtime that implements the business rule (§6.1). The gateway only maps transport.
- Every FR has the status `PENDING` at v1.0. Status vocabulary (used in §11 ledger): `PENDING` → `SCAFFOLDED` → `SOURCE-IMPLEMENTED` → `MIGRATION-ADDED` → `UNIT-VERIFIED` → `INTEGRATION-VERIFIED` → `RUNTIME-VERIFIED`. Only `RUNTIME-VERIFIED` with attached evidence (§11.0) counts as complete.
- All list endpoints use cursor pagination: `?limit=` (1–100, default 25) and `?cursor=` (opaque base64url of the sort key); responses include `nextCursor`.
- All mutations accept an optional `Idempotency-Key` header (≤ 128 chars); where an FR says "idempotent by", that key is mandatory.
- Every emitted event uses the canonical envelope (§6.4); every persisted mutation is audited where §2.12 says so.

### 2.1 Tenancy, Users & Service Accounts (Owner: `services/registry`)

- **FR-TEN-01**: `PLATFORM_ADMIN` creates a tenant with `slug` (`^[a-z0-9-]{3,40}$`, unique), `displayName` (1–120), `highValueThresholdUsd` (default 50000), `highRiskCountries` (ISO-3166 alpha-2 list), `demoMode` (default false), `retentionDays` (30–3650, default 400). Creates the tenant `ACTIVE`, emits `registry.tenant.created`, writes audit entry. Duplicate slug → `409 TENANT_SLUG_TAKEN`. Idempotent by `Idempotency-Key`.
- **FR-TEN-02**: `PLATFORM_ADMIN` suspends (`SUSPENDED`) or restores (`ACTIVE`) a tenant with a reason. While suspended: logins fail `403 TENANT_SUSPENDED`, webhooks for its sources return `403`, transaction/file submissions are rejected, consumers **still archive** in-flight events (no data loss) but sagas skip case creation and emit `ops` warnings. Emits `registry.tenant.suspended|restored`.
- **FR-TEN-03**: `PLATFORM_ADMIN` deactivates a tenant (`DEACTIVATED`, terminal): all credentials revoked, sources disabled, data retained until retention purge (FR-EVT-07, FR-FILE-12). Emits `registry.tenant.deactivated` (audited per FR-AUD-02); owning services apply the same tenant-status gate as for suspension, permanently. Hard delete is out of scope.
- **FR-TEN-04**: `TENANT_ADMIN` invites/creates users with `email` (RFC 5322, unique per tenant, stored lower-case), `displayName`, `roles[]` (non-empty subset of §1.4.6 tenant roles), and an initial password (≥ 14 chars, zxcvbn score ≥ 3) that must be changed at first login (`mustChangePassword`). Passwords hashed with Argon2id (m=64 MiB, t=3, p=1).
- **FR-TEN-05**: `TENANT_ADMIN` lists (filter by role, status; paginated), updates roles, disables, and re-enables users. A tenant must always retain ≥ 1 active `TENANT_ADMIN` (`409 LAST_TENANT_ADMIN`). Role changes revoke the user's refresh tokens and emit `registry.user.changed`; audited.
- **FR-TEN-06**: `TENANT_ADMIN` creates service accounts (role `INTEGRATION`) returning `clientId` and a one-time-displayed `clientSecret` (32 random bytes, base64url; stored as Argon2id hash). Supports rotate (new secret; previous valid for 24 h grace) and revoke. Audited via `registry.service_account.changed`.
- **FR-TEN-07**: Internal `SERVICE` accounts (one per runtime, §5.7) are provisioned by migration seed + Infisical secret; their allowed internal actions are an explicit allowlist claim `act[]` in the token. SERVICE token claims: `sub` (`svc-<runtime>`), `typ=service`, `act[]`, `iss=aegispulse-registry`, `aud=aegispulse-internal`, `jti`, `iat`, `exp`, `kid` header; no `tid`/`roles` (ADR-0010). Accounts and `allowed_actions` are seeded by `R__seed_service_accounts.sql` from §5.7.4; the registry reconciles each account's Argon2id secret verifier at startup from `SERVICE_CLIENT_SECRET_{RUNTIME}` (Infisical references to each runtime's own secret; changed secret → new verifier, previous valid 24 h) (ADR-0017).
- **FR-TEN-08**: Tenant settings (`highValueThresholdUsd`, `highRiskCountries`, `retentionDays`, `demoMode`) are readable by internal services via `getTenantSettings` and cached ≤ 60 s by callers; changes emit `registry.tenant.settings_changed`.
- **FR-TEN-09**: Platform bootstrap. A reserved tenant (`slug = platform`, fixed id `00000000-0000-0000-0000-000000000001`, seeded by a repeatable migration, not creatable/suspendable via the API) hosts `PLATFORM_ADMIN` users only. The registry one-shot command `bootstrap-platform-admin` (Kubernetes Job / compose `tools` profile) creates the first `PLATFORM_ADMIN` from `PLATFORM_ADMIN_BOOTSTRAP_EMAIL` + `PLATFORM_ADMIN_BOOTSTRAP_PASSWORD` when no active `PLATFORM_ADMIN` exists (no-op otherwise), with `mustChangePassword = true`, and writes an audit entry. A `PLATFORM_ADMIN` creates every other tenant's first `TENANT_ADMIN` by acting on that tenant via `X-Aegis-Tenant` (FR-AUTH-06).

### 2.2 Authentication & Authorization (Owner: `services/registry`; enforced in every service)

- **FR-AUTH-01**: `POST /v1/auth/login` with tenant slug, email, password returns an RS256 access JWT (TTL 15 min) and a rotating opaque refresh token (TTL 7 d, stored hashed). Claims: `sub`, `tid` (tenant UUID), `tslug`, `roles[]`, `typ=user`, `iss=aegispulse-registry`, `aud=aegispulse`, `jti`, `iat`, `exp`, `kid` header. Failed attempts are rate limited per (tenant, email): 5 per 15 min → `429 AUTH_RATE_LIMITED`; responses never reveal whether the email exists.
- **FR-AUTH-02**: `POST /v1/auth/refresh` rotates the refresh token (old one invalidated; reuse of an invalidated token revokes the whole token family and emits a security audit entry `AUTH_REFRESH_REUSE` as `registry.auth.refresh_reuse_detected`).
- **FR-AUTH-03**: `POST /v1/auth/logout` revokes the current refresh-token family. `GET /v1/auth/me` returns profile, tenant, roles.
- **FR-AUTH-04**: `POST /v1/auth/token` (client credentials) issues access tokens for `INTEGRATION` service accounts (TTL 15 min, no refresh) with claims `sub` (clientId), `tid`, `tslug`, `roles=["INTEGRATION"]`, `typ=integration`, `iss=aegispulse-registry`, `aud=aegispulse`, `jti`, `iat`, `exp`, `kid` header. Internal `SERVICE` accounts call `issueClientCredentialsToken` (`POST /internal/v1/issueClientCredentialsToken`, the only unauthenticated internal operation: client credentials in the body, rate limited per `clientId`) with `audience=aegispulse-internal`. Both paths allow 10 failed attempts per `clientId` per 5 min, then `429 AUTH_RATE_LIMITED`; a failure never reveals whether the client exists.
- **FR-AUTH-05**: Registry publishes a JWKS at `/.well-known/jwks.json` with current and previous signing keys (kid rotation every 90 days, previous key retained 24 h after rotation). The JWKS comes from `registry.signing_keys`: at startup the registry registers the public half of `JWT_SIGNING_KEY_CURRENT_PEM` under `JWT_SIGNING_KEY_CURRENT_KID` as `CURRENT` and demotes the former current key to `PREVIOUS` (published for 24 h, then `RETIRED`). Every service validates JWTs locally against the cached JWKS (refresh every 10 min or on unknown `kid`) — no service trusts the gateway's validation alone.
- **FR-AUTH-06**: Authorization is enforced in the owning service's service layer by role + tenant: the tenant in the token must equal the tenant of every resource read or mutated; cross-tenant access returns `404` (not `403`) to avoid resource enumeration. `PLATFORM_ADMIN` may pass `X-Aegis-Tenant` to act on a specific tenant; every such action is audited with `actingAs`.
- **FR-AUTH-07**: Password change endpoint `POST /v1/auth/password` (current + new; same policy as FR-TEN-04) revokes all other refresh-token families. The caller may pass its current `refreshToken` to keep that session; without it, every family is revoked. Clears `mustChangePassword`.

### 2.3 Tracked Entities & Watchlists (Owner: `services/registry`)

- **FR-ENT-01**: `ANALYST`+ creates tracked entities: `name` (1–200), `entityType` (`ORGANIZATION`, `TICKER`, `COUNTERPARTY`, `AGENCY`, `PERSON`), optional `ticker` (`^[A-Z.]{1,10}$`), `lei` (20-char ISO 17442), `country`, `aliases[]`. Normalized name (`lower`, strip punctuation, strip legal suffixes `inc|corp|llc|ltd|plc|holdings|group|sa|ag|nv`) must be unique per tenant (`409 ENTITY_DUPLICATE`). Emits `registry.entity.changed`.
- **FR-ENT-02**: Read, list (filter by type, watchlist, search `q` using trigram similarity), update, add/remove aliases, and archive (soft-delete, `archivedAt`) entities. Archived entities stop matching but remain referenced by historical cases.
- **FR-ENT-03**: `resolveEntities(tenantId, mentions[])` (internal): for each mention string returns the best entity match with `matchType` (`TICKER_EXACT`, `ALIAS_EXACT`, `NAME_NORMALIZED`, `TRIGRAM`), `similarity`, and `entityId`, using exact matches first and `pg_trgm` similarity ≥ 0.85 last. Unmatched mentions are returned with `entityId = null`. Deterministic for identical inputs.
- **FR-ENT-04**: `TENANT_ADMIN`/`ANALYST` create watchlists (`name` unique per tenant, `reason`, `severityFloor` default `HIGH`, `status` `ACTIVE|PAUSED`), add/remove entries (entity + note + `addedBy`), pause, and delete (soft). Emits `registry.watchlist.changed`; audited.
- **FR-ENT-05**: `checkWatchlists(tenantId, entityIds[] | counterpartyRefs[])` (internal) returns hits with watchlist id, name, and severityFloor; used by scoring and correlation sagas.

### 2.4 Webhook Ingestion (Owner: `services/ingestion`; transport: gateway)

- **FR-WHK-01**: `TENANT_ADMIN` registers a webhook source: `sourceKey` (`^[a-z0-9-]{3,60}$`, globally unique — it appears in the public URL), `displayName`, `trustLevel` (`TRUSTED|UNTRUSTED`, default `UNTRUSTED`), `payloadProfile` (`AEGIS_MARKET_EVENT_V1` at v1.0), `allowedAttachmentHosts[]`. Response includes the signing secret once (32 random bytes, base64url). Secrets are stored encrypted (AES-256-GCM, data key wrapped by the `INGESTION_KEK` from Infisical).
- **FR-WHK-02**: `POST /webhooks/{sourceKey}` accepts `application/json` ≤ 1 MiB with headers `X-Aegis-Signature: v1=<hex>` (comma-separated list allowed during rotation), `X-Aegis-Timestamp` (Unix seconds), `X-Aegis-Delivery-Id` (≤ 128 chars). Signed string is `{timestamp}.{deliveryId}.{rawBody}` (raw bytes, before JSON parsing). Verification: HMAC-SHA256 compared with constant-time equality against the current **and** previous secret; `|now − timestamp| ≤ 300 s`; Redis `SET NX` on `whk:nonce:{sourceId}:{deliveryId}` with TTL 900 s; durable unique `(source_id, delivery_id)`.
- **FR-WHK-03**: Outcomes: unknown/disabled source → `404 WEBHOOK_SOURCE_NOT_FOUND`; bad signature → `401 WEBHOOK_SIGNATURE_INVALID`; skew → `401 WEBHOOK_TIMESTAMP_SKEW`; repeated delivery id → `409 WEBHOOK_REPLAY_DETECTED`; schema invalid → `422 VALIDATION_ERROR` (after signature verification only); tenant suspended → `403 TENANT_SUSPENDED`; success → `202 {deliveryId, eventId, duplicate}`. Every rejection increments `aegispulse_webhook_rejected_total{source,reason}` and is logged without the body.
- **FR-WHK-04**: Payload profile `AEGIS_MARKET_EVENT_V1`: `externalId` (≤ 128), `category` (`REGULATION_PUBLISHED|IPO_FILED|ACQUISITION_ANNOUNCED|MARKET_ALERT|COMPLIANCE_DISCLOSURE`), `title` (≤ 500), `summary?` (≤ 4,000), `body?` (≤ 64 KiB), `publishedAt` (RFC 3339), `severity?` (scale §1.4.1), `url?` (https), `mentionedEntities?` (≤ 50 strings), `tickers?`, `attachments?` (≤ 5 of `{url, filename, contentType}`), `version?` (int, default 1).
- **FR-WHK-05**: On success, in one PostgreSQL transaction: store raw body to object storage (`raw/webhooks/{tenantId}/{yyyy}/{mm}/{dd}/{deliveryUuid}.json`, written *before* the transaction; orphan objects are swept), insert `webhook_deliveries`, insert the canonical envelope into `outbox_events`. Event type mapping: `REGULATION_PUBLISHED→external.regulatory.published`, `IPO_FILED→external.ipo.filed`, `ACQUISITION_ANNOUNCED→external.acquisition.announced`, `MARKET_ALERT→external.market.alert`, `COMPLIANCE_DISCLOSURE→external.compliance.disclosed`. `idempotencyKey = {sourceKey}:{externalId}:v{version}`; a second delivery with the same key returns `202 {duplicate:true}` and emits nothing. `classification.publisher_stated_severity = payload.severity`; `classification.source_trust_level` = the source's `trustLevel` at ingest (§1.4.3).
- **FR-WHK-06**: Attachments (Phase 11): for each attachment whose host is in `allowedAttachmentHosts`, Ingestion requests Files `registerRemoteFile` (sourceType `WEBHOOK_ATTACHMENT`); the Files Service fetches with SSRF guards (FR-FILE-11). Non-allowlisted hosts are recorded as `attachment_rejected` on the delivery, never fetched.
- **FR-WHK-07**: `TENANT_ADMIN` lists sources and deliveries (filter by outcome, date; paginated; raw body never returned, only metadata), disables/enables a source, changes trust level (audited — it affects `final_severity`), rotates the secret (new current; old becomes previous for 72 h then cleared by FR-WHK-08), and deletes (soft) a source.
- **FR-WHK-08**: Scheduled `expirePreviousSecrets` clears previous secrets older than 72 h and sweeps raw webhook objects with no delivery row older than 1 h.

### 2.5 Connector Pollers (Owner: `services/ingestion`; trigger: `workers/scheduler-trigger`)

- **FR-CON-01**: `TENANT_ADMIN` registers a connector: `kind` (`RSS|ATOM|SEC_EDGAR_ATOM|JSON_FEED`), `url` (https only; host added to the connector's allowlist), `schedule` (`intervalMinutes` 15–1440), `category` default for items, `trustLevel`, `mapping` (JSONPath per canonical field for `JSON_FEED`). Enable/disable, update, delete (soft).
- **FR-CON-02**: `runDueConnectors` (every 15 min via CronJob) fetches each due connector with conditional requests (`ETag`/`If-Modified-Since`), 10 s timeout, 5 MiB body cap, max 3 redirects within the allowlist, and DNS-rebinding/private-IP blocking (FR-FILE-11 guard reused). Advisory lock per connector prevents concurrent runs across replicas.
- **FR-CON-03**: Each feed item is normalized into `AEGIS_MARKET_EVENT_V1` (`externalId` = item guid/id or SHA-256 of link) and flows through the exact same persistence + idempotency + outbox path as FR-WHK-05 (`source = connector:{connectorKey}`). The cursor (`last_item_published_at`, `etag`) advances only after the transaction commits.
- **FR-CON-04**: Failures (HTTP ≥ 400, parse errors, timeouts) increment `consecutive_failures`; after 5 consecutive failures the connector is auto-paused (`PAUSED_ERROR`) and `notification.requested` (template N-05) is emitted. `POST /v1/connectors/{id}/run` triggers an immediate run (rate limited to 1/min per connector).

### 2.6 Transaction Intake & Risk Scoring (Owners: `services/ingestion`, `services/orchestrator`, `services/risk-scoring`, `services/cases`)

- **FR-TXN-01**: `INTEGRATION`/`ANALYST` submits `POST /v1/transactions`: `idempotencyKey` (required, ≤ 128), `accountId` (≤ 64), `counterpartyId` (≤ 64), `counterpartyName` (≤ 200), `amount` (decimal string, > 0, ≤ 18 digits, 2–4 decimals), `currency` (ISO 4217 in FX table), `country` (ISO alpha-2), `channel` (`WIRE|ACH|CARD|CRYPTO|INTERNAL`), `occurredAt` (≤ 24 h future skew rejected), `metadata` (object ≤ 4 KiB). Persists `transaction_submissions` + outbox `txn.submitted` atomically; returns `202 {transactionId, eventId}`. Same idempotency key + same body hash → original response; same key + different body → `409 IDEMPOTENCY_KEY_REUSED`.
- **FR-TXN-02**: Batch intake: a file uploaded with `purpose = TRANSACTION_BATCH` (CSV with header matching FR-TXN-01 fields, or JSON array; ≤ 50,000 rows) is parsed by Doc Extraction, which calls `submitTransactionBatch` in chunks of 500; row idempotency key = `{fileId}:{rowNumber}`. Invalid rows are reported in a row-error artifact; the file is `PROCESSED` with `rowsAccepted/rowsRejected` counts.
- **FR-TXN-03**: The `ScoreTransactionSaga` (orchestrator) consumes `txn.submitted`: (1) `checkWatchlists` for the counterparty, (2) `scoreTransaction` on Risk Scoring (2 s timeout, circuit breaker), (3) `recordRiskEvaluation` on Cases with `idempotencyKey = risk-eval:{eventId}`. Any step failure → retry tiers (§6.5); exhausted → DLQ. Saga steps are individually idempotent; no saga state is persisted.
- **FR-TXN-04**: Risk Scoring `score` (`POST /internal/v1/score`) computes features and the score per §1.4.4, returning `{score, band, factors[{name, value, contribution}], modelVersion, featureVersion, computedAt}`. Feature updates (velocity, counterparty history) are idempotent by `eventId` (Redis `SET NX feat:seen:{tenantId}:{eventId}` TTL 48 h) so redelivery does not inflate velocity.
- **FR-TXN-05**: Cases `recordRiskEvaluation` persists the evaluation and emits `risk.evaluation.recorded`. If `score ≥ 70` it opens a `TRANSACTION_RISK` case (FR-CASE-01) in the same transaction. Tenant `SUSPENDED` → evaluation recorded, case suppressed with `suppressedReason = TENANT_SUSPENDED`.
- **FR-TXN-06**: `GET /v1/transactions/{id}` returns submission, processing status (`ACCEPTED`, `SCORED`, `CASE_OPENED`, `FAILED`), latest evaluation, and linked case id (composed by the gateway from Ingestion + Cases typed clients).

### 2.7 Files Subsystem (Owner: `services/files`)

- **FR-FILE-01**: `POST /v1/files/uploads/init` with `filename` (≤ 255, sanitized: no path separators, control chars, or leading dots), `contentType` (allowlist: `application/pdf`, `text/html`, `text/csv`, `application/json`, `text/plain`), `sizeBytes` (1 B–64 MiB single PUT; 64 MiB–512 MiB multipart in Phase 4b), `sha256` (hex), `purpose` (`FILING|REGULATORY_DOCUMENT|TRANSACTION_BATCH|OTHER`), `relatedEntityIds?`. Creates `files` row `INITIATED`, Redis session `upload:session:{fileId}` (TTL 15 min), and returns a presigned PUT URL (expires 10 min, signed `Content-Type` and `Content-Length`). Object key: `raw/{tenantId}/{yyyy}/{mm}/{dd}/{fileId}` — never derived from the filename.
- **FR-FILE-02**: Deduplication: if `(tenantId, sha256)` exists in Redis `file:dedup:{tenantId}:{sha256}` (TTL 24 h) or in a non-`FAILED`/`EXPIRED` file row, init returns `200 {fileId: existing, deduplicated: true}` with no upload URL. Dedup is disabled per request with `allowDuplicate: true` (`ANALYST`+ only).
- **FR-FILE-03**: Quotas: per tenant ≤ 60 inits/min (Redis token bucket `quota:files:{tenantId}`), ≤ 10 GiB stored (sum of non-expired files); breach → `429 UPLOAD_RATE_LIMITED` / `413 STORAGE_QUOTA_EXCEEDED`.
- **FR-FILE-04**: `POST /v1/files/uploads/{fileId}/complete` (by uploader or `ANALYST`+ of same tenant): verifies session exists, object exists (`HEAD`), and size equals declared size; transitions `INITIATED → UPLOADED`, emits `file.uploaded` + `file.status.changed` via outbox, deletes the session. Missing object → `409 UPLOAD_NOT_FOUND_IN_STORAGE`; already completed → idempotent `200` with current status.
- **FR-FILE-05**: Validation consumer (`files.validation.q`, on `file.uploaded`): streams the object computing SHA-256, sniffs magic bytes (PDF `%PDF-`, JSON/CSV/HTML/text heuristics) against declared type, enforces size, and scans with ClamAV (`clamd` INSTREAM). Outcomes: all pass → `VALIDATED` + `doc.file.ready`; checksum or size mismatch → `FAILED` (`failureReason`); malware or type mismatch → object moved to `quarantine/{tenantId}/{fileId}`, `QUARANTINED`, `notification.requested` (N-03). Idempotent: a file not in `UPLOADED` is acked without action.
- **FR-FILE-06**: Processing lifecycle API for Doc Extraction: `markProcessing(fileId, extractorVersion)` (`VALIDATED → PROCESSING`, idempotent), `recordExtractionResult(fileId, result)` (`PROCESSING → PROCESSED`, persists artifact keys, emits `doc.extraction.completed` or `doc.extraction.review_required`), `recordProcessingFailure(fileId, reason, retryable)` (`PROCESSING → FAILED` when not retryable).
- **FR-FILE-07**: `GET /v1/files/{fileId}` returns metadata + status + artifact summary; responses cached in Redis `file:status:{fileId}` TTL 30 s, invalidated on every transition.
- **FR-FILE-08**: `GET /v1/files/{fileId}/download-url` returns a presigned GET URL (TTL 5 min, `Content-Disposition: attachment`, sanitized filename) for `VALIDATED|PROCESSING|PROCESSED` files; cached ≤ 4 min. `QUARANTINED` files are downloadable only by `TENANT_ADMIN` with `?acknowledgeQuarantine=true` (audited).
- **FR-FILE-09**: `GET /v1/files` lists files (filter by status, purpose, uploadedBy, date; paginated).
- **FR-FILE-10**: Orphan sweep (every 15 min): `INITIATED` files older than 1 h → `EXPIRED`, objects deleted, multipart uploads aborted; emits `file.status.changed`.
- **FR-FILE-11**: `registerRemoteFile(tenantId, url, sourceType, allowedHosts)` fetches remote attachments/connector documents with SSRF protection: https only, host allowlist, resolve DNS and reject private/loopback/link-local/metadata ranges (IPv4+IPv6) before connect and re-check on connect, 30 s timeout, 64 MiB cap, no credentials forwarded. Result enters the lifecycle at `UPLOADED`.
- **FR-FILE-12**: `DELETE /v1/files/{fileId}` (`TENANT_ADMIN`) soft-deletes (`deletedAt`, object retained until retention purge); retention purge job deletes objects and artifacts past `tenant.retentionDays`, keeping a tombstone row. Audited: the delete emits `ops.audit.file_deleted` (FR-AUD-02) through the outbox and records the actor in the file's status history.
- **FR-FILE-13** (Phase 5b): Multipart upload for 64–512 MiB files: init returns `uploadId` and presigned part URLs (16 MiB parts, ≤ 32 parts, every request < Cloudflare's 100 MB edge cap); complete accepts the part ETag list.

### 2.8 Document ETL & Extraction (Owner: `services/doc-extraction`)

- **FR-DOC-01**: Consumer `doc.extraction.q` (on `doc.file.ready`, prefetch 2) calls `markProcessing`, downloads the object via the Files service's internal presigned URL (no shared bucket credentials), and routes by `purpose`: `TRANSACTION_BATCH` → FR-TXN-02; others → FR-DOC-02..05.
- **FR-DOC-02**: Parsing: PDF text via `pdfplumber`; scanned PDFs (text yield < 50 chars/page) via Tesseract OCR (Phase 11, max 50 pages); HTML via `selectolax` with script/style stripped; CSV/JSON preview to text; Unicode NFKC normalization, whitespace collapsing, de-hyphenation. Chunking: 1,000-token windows, 100-token overlap, chunk ids `{fileId}:{n}`.
- **FR-DOC-03**: Extraction: named entities (ORG, PERSON, GPE, agencies) via spaCy `en_core_web_sm`; tickers via `\$?[A-Z]{1,5}(\.[A-Z])?` validated against Registry entities; event-type classification (`REGULATION_PUBLISHED|IPO_FILED|ACQUISITION_ANNOUNCED|COMPLIANCE_DISCLOSURE|OTHER`) via rules-then-classifier; red-flag clauses per `clauses-v1` with sentence offsets.
- **FR-DOC-04**: Output is validated by a strict Pydantic model (`ExtractionResultV1`, `extra="forbid"`); overall confidence = weighted mean (entities 0.4, event type 0.4, parse quality 0.2). `confidence ≥ 0.70` → `recordExtractionResult(status=COMPLETED)`; `< 0.70` or schema violation → `status=REVIEW_REQUIRED` and Cases opens an `EXTRACTION_REVIEW` case via the orchestrator saga.
- **FR-DOC-05**: Artifacts written to `artifacts/{tenantId}/{fileId}/{extractorVersion}/` (`text.txt`, `chunks.jsonl`, `extraction.json`); keys are deterministic so redelivery overwrites identically. Max processing time 120 s per file; exceeded → retryable failure.
- **FR-DOC-06**: `doc.extraction.completed` payload carries `fileId`, `extractorVersion`, `eventTypeGuess`, `mentionedEntities[]`, `redFlags[]`, `confidence`, and `textExcerpt` (≤ 2,000 chars) — never the full text.

### 2.9 Event Archive (Owner: `services/events`)

- **FR-EVT-01**: Consumer `events.archive.q` (bound `#` on all four topic exchanges) validates the envelope against the JSON Schema for its `schemaVersion`; invalid envelopes are dead-lettered as poison (no retry) with `x-aegis-error-code = ENVELOPE_INVALID`.
- **FR-EVT-02**: Insert into `events_archive` (or `events_restricted_audit` when Stage 1 sensitivity = `RESTRICTED`) using unique index `(tenantId, eventId)`; duplicate key = success (ack). Replayed messages (`x-aegis-replay-job` header) never create records; they update `replay.count/lastReplayedAt` only.
- **FR-EVT-03**: Stored document includes the envelope fields, `exchange`, `routingKey`, `archivedAt`, redacted `payload`, `redactions[{path, rule, kind}]`, `payloadSha256` (of the pre-redaction payload), `classification`, `status`, `statusHistory[]`, `classificationHistory[]`, `replay`, and `expireAt` (archivedAt + tenant retentionDays; 7 years for restricted).
- **FR-EVT-04**: `GET /v1/events` searches by `correlationId`, `eventType` (prefix match), `finalSeverity` (≥), `status`, `source`, `entity` (mentioned entity id), `from`/`to` on `occurredAt`; sorted `occurredAt desc`; paginated. `VIEWER`/`ANALYST` never see restricted events; `COMPLIANCE_AUDITOR` queries restricted events via `?tier=restricted`.
- **FR-EVT-05**: `GET /v1/events/{eventId}` returns the full archived record including lineage histories; `GET /v1/events/correlation/{correlationId}` returns the ordered causal chain (by `causationId`).
- **FR-EVT-06**: Internal `searchEventsForEntities(tenantId, entityIds[], eventTypes[], since)` supports correlation sagas (FR-COR-01).
- **FR-EVT-07**: Retention: TTL indexes on `expireAt`; Phase 15 cold-tier export writes Parquet to `archive/{tenantId}/{yyyy}/{mm}/` before expiry and sets status `ARCHIVED`.

### 2.10 Two-Stage Classification (Owners: `services/events`, `services/sensitivity-scanner`)

- **FR-CLS-01**: Stage 1 runs synchronously inside the archive consumer before insert (§1.4.2): sets `sensitivity`, `categories`, `algorithm_severity` (= rule severity), `classification_source = RULES`, `rule_version`, masks detected values, and sets `status = RULE_SCANNED`. Budget: p95 ≤ 5 ms per event.
- **FR-CLS-02**: If Stage 2 is not required, the same transaction sets `status = CLASSIFIED`, computes `final_severity` (§1.4.3), and writes `classification.finalized` to the Mongo outbox.
- **FR-CLS-03**: If Stage 2 is required, the transaction writes `classification.scan.requested` to the outbox. Consumer `events.classification.q` calls Scanner `scan` (`POST /internal/v1/scan`) (10 s timeout, circuit breaker: 50% failures over 20 calls opens for 30 s) with the redacted text fields only.
- **FR-CLS-04**: Scanner returns `{sensitivity, categories[], severity, confidence, classifierVersion, spans[]}` validated by Pydantic. Phase 6 records scan requests only; Phase 12a ships a deterministic lexicon stub (`sensitivity-stub-v0`); Phase 12b ships TF-IDF + logistic regression (`sensitivity-clf-v1.x`) and an optional LLM adjudicator for confidence 0.40–0.60 (disabled by default, §6.3).
- **FR-CLS-05**: Patch: append to `classificationHistory`, set `status AI_SCANNED → CLASSIFIED`, recompute `algorithm_severity`/`final_severity` (elevate-only), set `classification_source = AI_SCANNER`, and emit `classification.finalized`. If sensitivity becomes `RESTRICTED`, move the document to `events_restricted_audit` in the same Mongo transaction and emit `notification.requested` (N-02). Patches are conditional on `classificationRevision` (optimistic concurrency) so duplicate scan results are no-ops.
- **FR-CLS-06**: Circuit open or retries exhausted → event stays `RULE_SCANNED` with `final_severity` = rule severity (never blocked), flagged `pendingAiScan = true`; a 15-minute sweep re-requests scans for flagged events ≤ 24 h old.
- **FR-CLS-07**: `PATCH /v1/events/{eventId}/classification` (`ANALYST`+): override `final_severity` and/or `sensitivity` with `justification` (≥ 20 chars). Sets `OVERRIDDEN`, records actor and before/after in `classificationHistory`, emits `classification.overridden` (Cases records audit entry).

### 2.11 Event Replay (Owner: `services/events`)

- **FR-RPL-01**: `POST /v1/events/replay` (`TENANT_ADMIN` for own tenant; `PLATFORM_ADMIN` any): filter by exactly one of `correlationId`, `eventType` + `from`/`to`, or `from`/`to` (window ≤ 31 days); `target` = `ORIGINAL_ROUTE` or `QUEUE:{allowlisted queue}`; `reason` (≥ 10 chars); `dryRun`; `maxEvents` ≤ 10,000. Creates `replay_jobs` (`PENDING`) and returns `202 {jobId, matchedCount (dryRun)}`.
- **FR-RPL-02**: Replay worker publishes matched events in `occurredAt` order at ≤ 200 msg/s with publisher confirms, preserving `eventId`/`correlationId`, setting headers `x-aegis-replay-job`, `x-aegis-replay-generation` (job sequence), and `causationId` unchanged. Progress (`publishedCount`, `lastEventId`) is checkpointed every 100 messages; a restarted worker resumes from the checkpoint.
- **FR-RPL-03**: Consumers deduplicate on `(consumer, eventId, replayGeneration)`; domain services still enforce business idempotency, so replays never create duplicate case transitions (verified by FR-CASE-07 tests).
- **FR-RPL-04**: `GET /v1/events/replay/{jobId}` returns status (`PENDING|RUNNING|COMPLETED|CANCELLED|FAILED`) and progress; `POST .../cancel` stops at the next checkpoint. Replays are audited and archive records get `status = REPLAYED`.

### 2.12 Risk Cases & Policy Engine (Owner: `services/cases`)

- **FR-CASE-01**: Cases open from: risk evaluation ≥ 70 (`TRANSACTION_RISK`), watchlist hit on a HIGH+ external/doc event (`DOCUMENT_RISK`), low-confidence extraction (`EXTRACTION_REVIEW`), or correlation (`CORRELATED`). Fields: `caseNumber` (per-tenant sequence `AP-{yyyy}-{000001}`), type, status, severity, policyScore, primary entity ids, trigger event id, assignee, timestamps. Opening is idempotent by `(tenant_id, open_idempotency_key)`.
- **FR-CASE-02**: State machine (transitions outside this table → `409 CASE_INVALID_TRANSITION`):

  | From | To | Trigger |
  |---|---|---|
  | `OPEN` | `ENRICHING` | automatic on open |
  | `ENRICHING` | `POLICY_EVALUATED` | enrichment complete or 10-min enrichment timeout |
  | `POLICY_EVALUATED` | `ESCALATED` / `CLEARED` | policy outcome (§1.4.5) |
  | `ESCALATED`, `CLEARED` | `ENRICHING` | re-evaluation trigger (FR-COR-02, manual) |
  | `ESCALATED` | `RESOLVED` | disposition `TRUE_POSITIVE` or `FALSE_POSITIVE` |
  | `CLEARED` | `RESOLVED` | disposition, or auto after 7 days with no new evidence |

  `RESOLVED` is terminal; new evidence on a resolved case opens a new `CORRELATED` case linking `previousCaseId`.
- **FR-CASE-03**: Every transition is idempotent by `(case_id, transition_key)` (e.g., `policy:{evaluationRevision}`), increments `version` (optimistic locking), inserts `case_transitions`, writes an audit entry (FR-AUD-01), and emits `case.transitioned` (+ `case.escalated`/`case.resolved`) via outbox — all in one transaction.
- **FR-CASE-04**: Policy evaluation (§1.4.5) runs on entering `POLICY_EVALUATED`; result stored with `policyVersion` and factor breakdown. Escalation to `CRITICAL` severity emits `notification.requested` (N-01). Escalation to ≥ `HIGH` emits `correlation.requested`.
- **FR-CASE-05**: Analysts list (filter by status, type, severity, assignee, entity; paginated), view (with timeline of transitions, evidence, notes, dispositions), assign/unassign (`ANALYST`+), add notes (≤ 4,000 chars, immutable after 15 min), and request manual re-evaluation.
- **FR-CASE-06**: `POST /v1/cases/{id}/dispositions` (`ANALYST`+): `disposition` (`TRUE_POSITIVE|FALSE_POSITIVE|NEEDS_REVIEW`), `rationale` (≥ 20 chars). `NEEDS_REVIEW` keeps status and requires a different analyst for the final disposition (four-eyes). Emits `case.disposition.recorded` with model/rule versions of the contributing evaluations.
- **FR-CASE-07**: Concurrency and duplicates: concurrent transitions resolve via optimistic locking (loser retries up to 3× then `409 CASE_CONFLICT`); duplicate triggers (redelivery, replay) produce zero additional transitions or audit entries.
- **FR-CASE-08**: `attachEvidence(caseId, items[])` (internal) is idempotent by `(case_id, evidence_type, evidence_ref)`; attaching evidence to `ESCALATED`/`CLEARED` cases triggers re-evaluation; to `RESOLVED` cases triggers FR-CASE-02's new-case rule.

### 2.13 Immutable Compliance Audit Log (Owner: `services/cases`)

- **FR-AUD-01**: Append-only `audit_log` entries: `actorType` (`USER|SERVICE|SYSTEM`), `actorId`, `actingAs?`, `action`, `subjectType`, `subjectId`, `triggerEventId?`, `triggerFileId?`, `modelVersion?`, `ruleVersion?`, `before`, `after`, `occurredAt`, per-tenant `seq`, `prevHash`, `hash = SHA-256(canonicalJSON(entry without hash) ‖ prevHash)`. Insert serialized per tenant via `pg_advisory_xact_lock`. The DB role has no `UPDATE`/`DELETE`/`TRUNCATE` grants and a trigger rejects them.
- **FR-AUD-02**: Cases consumes audit-worthy events from other services (`registry.user.changed`, `registry.tenant.*`, `registry.service_account.changed`, `registry.auth.refresh_reuse_detected`, `registry.watchlist.changed`, `classification.overridden`, webhook source trust changes, quarantine downloads, file deletions (`ops.audit.file_deleted`), dead-letter replays/discards (`ops.audit.dead_letter_resolved`), replay jobs) into the same chain, idempotent by source `eventId`.
- **FR-AUD-03**: `GET /v1/audit` (`COMPLIANCE_AUDITOR`, `TENANT_ADMIN`) filters by subject, actor, action, date; paginated. `GET /v1/audit/verify?fromSeq&toSeq` recomputes the chain and returns `{valid, checked, firstBrokenSeq?}`; a nightly job verifies the last 24 h and emits `notification.requested` (N-06) on failure.

### 2.14 Cross-Domain Correlation (Owners: `services/orchestrator`, `services/cases`)

- **FR-COR-01**: `CaseCorrelationSaga` on `correlation.requested` (case escalated ≥ HIGH): calls `searchEventsForEntities(entityIds, ['external.*','doc.extraction.completed'], since = now − 30 d)`, filters `final_severity ≥ MEDIUM`, and calls `attachEvidence` with up to 20 most recent items.
- **FR-COR-02**: `ClassifiedSignalSaga` on `classification.finalized` for `external.*` and `doc.extraction.completed` with `final_severity ≥ HIGH`: resolves `mentionedEntities` (FR-ENT-03), checks watchlists (FR-ENT-05), then (a) calls `reevaluateOpenCases(entityIds, triggerEventId)` for open/escalated/cleared cases on those entities, and (b) on a watchlist hit with no open case for that entity, opens a `DOCUMENT_RISK` case (`open_idempotency_key = doc-risk:{eventId}:{entityId}`).
- **FR-COR-03**: Correlation fan-out is bounded: ≤ 50 entities per event, ≤ 100 cases re-evaluated per trigger (excess logged and counted in `aegispulse_correlation_truncated_total`).

### 2.15 Messaging Resilience & Dead Letters (Owners: shared consumer kits; `services/events` for the dead-letter registry)

- **FR-MSG-01**: Every consumer uses the platform consumer kit (§6.5): manual ack after successful processing, prefetch per §5.5, retry tiers `1 s → 5 s → 30 s` via TTL queues with `x-retry-count`, then dead-letter to `{queue}.dlq` via `aegispulse.dlx`. Errors are classified: `TRANSIENT` (retry), `PERMANENT`/`POISON` (DLQ immediately).
- **FR-MSG-02**: Dead-letter registry consumer (`events.deadletter.q`, bound to all `*.dlq` via `aegispulse.dlx` routing `#`) stores each dead letter in Mongo `dead_letters` (original envelope, headers, queue, error code/message/stack hash, retry count, first/last failure time) and acks; emits `ops.dead_letter.recorded`.
- **FR-MSG-03**: `GET /v1/ops/dead-letters` (`PLATFORM_ADMIN`; `TENANT_ADMIN` sees own tenant) lists/filters by queue, error code, date; `GET .../{id}` shows details (envelope, raw body, headers and error message masked by the rules-v1 detectors with a `redactions[]` list, §1.4.2); `POST .../{id}/replay` republishes to the original queue with `x-retry-count = 0` (via `aegispulse.retry` to that queue's shortest retry/delay queue, whose TTL dead-letters into it, so no default-exchange grant is needed) and marks `REPLAYED`. The publish is confirmed before the status change and its audit row commit; a commit failure after the publish leaves the record OPEN (at-least-once replay, absorbed by consumer dedup, NFR-02); `POST .../{id}/discard` marks `DISCARDED` with reason. Audited: both emit `ops.audit.dead_letter_resolved` (FR-AUD-02) through the Mongo outbox with the status change.
- **FR-MSG-04**: OpenObserve alert: dead letters > 10 in 5 min or any `*.dlq` depth > 0 for 10 min → ntfy (N-04).

### 2.16 Real-Time Status Streaming (Owner: gateway transport)

- **FR-SSE-01**: `GET /v1/stream` (authenticated, `text/event-stream`) streams tenant-scoped projections of `case.*`, `file.status.changed`, `classification.finalized`, `doc.extraction.*`, `risk.evaluation.recorded`. The gateway binds an exclusive auto-delete queue per pod and filters by `tenantId` and role (restricted events never streamed). Projections contain ids, type, status, severity, and timestamps only — no payload bodies.
- **FR-SSE-02**: Heartbeat comment every 15 s; `id:` is the eventId; `Last-Event-ID` is accepted but gap-filling is best-effort (clients re-fetch via REST on reconnect). Max 5 concurrent streams per user (`429 STREAM_LIMIT`), idle timeout 1 h.

### 2.17 Notifications (Owner: emitting service decides; `services/orchestrator` delivers)

- **FR-NOTIF-01**: Services emit `notification.requested` with `templateId`, `severity`, and template variables; the orchestrator's `NotificationDispatch` renders and POSTs to ntfy with priority mapping (`CRITICAL→5`, `HIGH→4`, else `3`), deduplicated by `notificationKey` within 10 min (idempotency via ntfy message id = UUIDv5 of key). Bodies never include PII, payload text, or secrets — ids, severities, and console links only.
- **FR-NOTIF-02**: Templates:
  1. **N-01 Critical case escalated** — "AegisPulse ⚠ CRITICAL case {caseNumber} ({type}) for {entityName} — policy score {policyScore}. {consoleUrl}/cases/{caseId}"
  2. **N-02 Event classified RESTRICTED/CRITICAL** — "Event {eventType} from {source} classified {sensitivity}/{finalSeverity}. {consoleUrl}/events/{eventId}"
  3. **N-03 File quarantined** — "File {fileId} quarantined ({reason}) for tenant {tenantSlug}."
  4. **N-04 Dead-letter spike** — "{count} dead letters on {queue} in {window}."
  5. **N-05 Connector auto-paused** — "Connector {connectorKey} paused after {failures} failures."
  6. **N-06 Audit chain verification failed** — "Audit chain broken for tenant {tenantSlug} at seq {seq}."
  7. **N-07 Drift detected** — "{metric} drift {value} (threshold {threshold}) for {scope}."

### 2.18 Data Intelligence & Feedback (Owner: `services/data-intel`)

- **FR-INTEL-01**: Fact ingestion consumer (`intel.facts.q`) records `risk.evaluation.recorded`, `classification.finalized`, `classification.overridden`, `doc.extraction.*`, `file.status.changed`, `case.*` into fact tables, idempotent by `eventId`, including ingestion latency (`ingestedAt − occurredAt`, `archivedAt − ingestedAt`).
- **FR-INTEL-02**: Rollups: micro-batch every 15 min (today's partitions) and nightly 02:00 UTC (full previous day): `rollup_entity_risk_daily`, `rollup_source_reliability_daily` (delivery count, rejection rate, disagreement rate, mean latency), `rollup_exposure_daily` (by category/sector). Emits `intel.rollup.completed`.
- **FR-INTEL-03**: Drift: weekly-window PSI of risk scores vs. a 28-day baseline per tenant (PSI > 0.2 → MEDIUM, > 0.3 → HIGH); extraction confidence mean drop > 10% vs. 7-day baseline; publisher-vs-algorithm disagreement rate > 35% per source. Breaches persist `drift_metrics` and emit `intel.drift.detected` + `notification.requested` (N-07).
- **FR-INTEL-04**: Closed loop: dispositions compute precision = TP/(TP+FP) per `modelVersion`, `ruleVersion`, `policyVersion`, case type, rolling 30 d; exposed via `GET /v1/intel/precision`.
- **FR-INTEL-05**: Read APIs: `GET /v1/intel/summary`, `/drift`, `/disagreement`, `/latency`, `/precision`, `/eval-runs` (`ANALYST`+, tenant-scoped; `PLATFORM_ADMIN` cross-tenant).
- **FR-INTEL-06**: Daily Parquet export of fact tables to `analytics/{table}/dt={date}/` (tenant column retained; bucket policy restricts read to data-intel).

### 2.19 Evaluation Harness (Owner: `eval/` + Python services)

- **FR-EVAL-01**: Golden dataset in `eval/golden/` (versioned, synthetic): ≥ 40 regulatory texts, ≥ 20 IPO notices, ≥ 20 M&A announcements, ≥ 20 ad-hoc filings (PDF/HTML/CSV), ≥ 30 adversarial/malformed webhook payloads, ≥ 500 labeled transactions; each item has expected labels in `labels.jsonl`.
- **FR-EVAL-02**: `make eval` runs extraction, scanner, and scoring against the golden set and writes `eval/reports/{timestamp}.json` with entity extraction precision/recall, sensitivity macro-F1, severity accuracy, publisher-vs-algorithm comparison, schema compliance rate, and latency p50/p95. Results are posted to data-intel `recordEvalRun`.
- **FR-EVAL-03**: CI gate (Python service changes): entity precision ≥ 0.85, sensitivity macro-F1 ≥ 0.80, schema compliance = 100%, no metric regresses > 3 points vs. the committed baseline `eval/baseline.json`.
- **FR-EVAL-04**: Adversarial webhook suite asserts 100% rejection of bad signatures, stale timestamps, replayed delivery ids, oversize bodies, and malformed JSON; duplicate-event suite asserts exactly one archive record and zero duplicate case transitions.

### 2.20 Analyst Console (Owner: `apps/console`)

- **FR-FE-01**: Login, password change on first login, logout, silent refresh; tenant slug + email + password form; accessible error messages.
- **FR-FE-02**: Live pipeline dashboard: SSE-driven feed of recent events, file statuses, and case changes; counters by severity; reconnect indicator.
- **FR-FE-03**: Cases: list with filters, detail (timeline, evidence links, policy factor breakdown, notes), assign, disposition form with four-eyes rule surfaced.
- **FR-FE-04**: Events explorer: search filters (FR-EVT-04), detail with severity lineage visualization (publisher → algorithm → final, history table), override form (FR-CLS-07).
- **FR-FE-05**: Files: drag-and-drop upload computing SHA-256 client-side (Web Crypto), init → PUT → complete, progress, status timeline, download link.
- **FR-FE-06**: Admin: users, service accounts, webhook sources (secret shown once), connectors, watchlists & entities (tenant admin); replay jobs and dead letters (admins); audit log + verify (auditor).
- **FR-FE-07**: Intelligence: drift, disagreement, latency, and precision charts.
- **FR-FE-08**: Role-aware navigation (hidden + server-enforced), responsive ≥ 360 px, WCAG 2.2 AA (keyboard navigation, focus states, contrast), dark/light themes.

### 2.21 Portfolio Demo Tooling (Owner: `scripts/demo/`)

- **FR-DEMO-01**: `make demo` runs a scripted scenario against local, dev, or prod (`ENV=`): signed webhooks for a regulation, IPO, acquisition (mentioning a watchlisted entity), a transaction burst that crosses the case threshold, a filing PDF upload, and a CSV batch — printing correlation ids and console links.
- **FR-DEMO-02**: `scripts/demo/webhook-sign.ts` signs arbitrary payloads for a source; `scripts/demo/upload.ts` performs the three-step upload; `scripts/demo/chaos/*.sh` produce duplicate webhook floods, consumer restarts, and scanner latency injection (Phase 18).

### 2.22 Explicitly Out of Scope (v1.0)

- Real market-data/vendor contracts, real PII, live FX rates, SSO/SAML/OIDC federation (local identity only), multi-region deployment, GPU inference, mobile apps, per-tenant encryption keys (single KEK per service), hard deletion of tenant data, billing.


---

## 3. Non-Functional Requirements

Each NFR is a measurable policy. "Evidence" names the automated or runtime check that proves it; an NFR is not complete until that evidence exists (§11.0). Environment column: **L** = local, **H** = homelab, **P** = reference production.

### NFR-01 — Asynchronous Processing
- Ingress HTTP handlers (webhooks, transactions, file complete) return after durable persistence + outbox write; no request waits on scoring, extraction, classification, or archive. Targets (H): webhook p95 ≤ 150 ms, transaction p95 ≤ 100 ms, upload init p95 ≤ 150 ms at 20 req/s.
- End-to-end latency targets (H, idle cluster): webhook → `classification.finalized` p95 ≤ 15 s (with Stage 2); `txn.submitted` → `risk.evaluation.recorded` p95 ≤ 3 s; file complete → `PROCESSED` p95 ≤ 60 s for a 5 MiB text PDF.
- Evidence: k6 load script `tests/load/ingress.js` report + OpenObserve latency query screenshots in phase-exit evidence.

### NFR-02 — Idempotency, Deduplication & Delivery Semantics
- Broker delivery is **at-least-once**; every consumer is idempotent. Dedup keys: archive `(tenantId, eventId)`; generic consumers `processed_messages(consumer, event_id, replay_generation)` table/collection in the owning store with 14-day retention; business ops have explicit idempotency keys (FR-TXN-01, FR-CASE-01/03, FR-CASE-08, FR-WHK-05).
- HTTP idempotency: `Idempotency-Key` stored with request-body SHA-256 and response for 24 h; mismatched body → `409 IDEMPOTENCY_KEY_REUSED`.
- Producers with PostgreSQL use the **transactional outbox** (§6.6); Events Service uses a Mongo outbox collection within the same transaction; stateless producers use deterministic UUIDv5 eventIds + publisher confirms.
- Event ordering is **not** guaranteed; consumers rely on versions/revisions (case `version`, `classificationRevision`) not arrival order.
- Evidence: integration tests that redeliver every message type 3× and replay jobs over seeded data, asserting zero duplicate rows/transitions/audit entries (FR-EVAL-04).

### NFR-03 — Cost Efficiency
- Portfolio runs on owned homelab hardware: zero cloud spend for compute/data; optional LLM spend capped at USD 5/month via `SCANNER_LLM_MONTHLY_BUDGET_USD` (scanner refuses LLM calls when exceeded, falls back to classifier).
- Per-namespace request budgets (§5.4), by node tier (ADR-0015): **prod** compute tier (`optiplex` + `elitedesk-800`) ≤ 2.0 vCPU / 4.5 GiB, storage tier (`optiplex-tower`) ≤ 1.0 vCPU / 4 GiB; **dev** compute ≤ 1.0 vCPU / 3.0 GiB, storage ≤ 0.5 vCPU / 2 GiB. Dev may be scaled to zero when idle (`make env-sleep ENV=dev`, nightly `env-sleep` scheduled pipeline at 01:00 local; any dev deploy wakes it).
- Evidence: `kubectl describe node` allocation snapshot per release; `ci/check-resource-budget.sh` sums manifest requests and fails over budget.

### NFR-04 — Testability & Layering
- Service and domain modules are framework-agnostic: no NestJS/Fastify/Express/Spring Web/FastAPI/AMQP types import into `src/service/` or `src/domain/` (enforced by `dependency-cruiser` (TS), ArchUnit (Java), `import-linter` (Python)).
- Coverage gates: service/domain layers ≥ 85% lines, overall ≥ 75% per runtime (SonarQube quality gate).
- Evidence: architecture tests in each runtime's unit suite; SonarQube gate status.

### NFR-05 — Local Dev Parity
- `docker compose` brings up the same datastores and broker versions as dev and prod (PostgreSQL 18, MongoDB 8 replica set, Redis 8, RabbitMQ 4, S3-compatible object store, OpenObserve, ClamAV). Same migrations, same topology declarations (`packages/contracts/topology/aegispulse.topology.json`), same images.
- No `if (env === 'local')` business branches; environment differences are configuration only (URLs, replica counts, budgets, feature flags listed in §10.4).
- Evidence: CI `e2e-compose` job runs the E2E suite against compose; dev runs the full smoke + security suites post-deploy and prod runs the smoke subset after promotion.

### NFR-06 — Environment Isolation
- `local`, `dev`, and `prod` share nothing except cluster-level platform services: separate namespaces (`aegispulse-dev`, `aegispulse`), separate datastores (each namespace runs its own PostgreSQL/MongoDB/Redis/object-store StatefulSets), separate Infisical environments, separate RabbitMQ vhosts (`aegispulse-local` in compose, `aegispulse-dev` / `aegispulse-prod` on cluster) and users, separate buckets (`aegispulse-local-*`, `aegispulse-dev-*`, `aegispulse-prod-*`), separate JWT signing keys and webhook KEKs, separate OpenObserve streams and ntfy topics, separate domains. NetworkPolicies deny all traffic between `aegispulse-dev` and `aegispulse`. Tokens minted in dev are invalid in prod (different `iss` keys and `aud` claim `aegispulse-dev`).
- Tenant isolation inside an environment: every query is tenant-filtered in repositories; PostgreSQL Row-Level Security on all tenant tables (`app.tenant_id` set with `SET LOCAL` per transaction); Mongo repository wrapper rejects queries without `tenantId`; Redis keys always contain `tenantId` where tenant-scoped; object keys always prefixed by `tenantId`.
- Evidence: cross-tenant integration suite (tenant B token against tenant A ids → 404 for every route in §8.3).

### NFR-07 — Observability
- Structured JSON logs on stdout (pino / Logback JSON encoder / structlog) with mandatory fields: `ts`, `level`, `service`, `version`, `env`, `traceId`, `spanId`, `correlationId`, `tenantId` (when known), `eventId` (when processing a message), `msg`. Never log secrets, raw webhook bodies, file contents, or unmasked PII (log redaction allowlist per runtime).
- OpenTelemetry traces spanning gateway → service → outbox → RabbitMQ (W3C `traceparent` propagated in message headers) → consumers → downstream HTTP; exported via OTLP/HTTP to OpenObserve.
- Metrics (OTel → OpenObserve): `http_server_duration`, `aegispulse_webhook_rejected_total`, `aegispulse_outbox_lag_seconds`, `aegispulse_consumer_processed_total{queue,outcome}`, `aegispulse_consumer_lag_messages`, queue depth (RabbitMQ Prometheus plugin), `aegispulse_archive_writes_total`, `aegispulse_file_upload_duration`, `aegispulse_inference_duration{model}`, `aegispulse_classification_stage_total{stage,source}`, `aegispulse_case_transitions_total{to}`, `aegispulse_correlation_truncated_total`.
- No silent failures: every caught error is either rethrown, converted to a typed result that is handled, or logged at `error` with an error code; consumer failures always end in ack-after-success, retry, or DLQ.
- Evidence: trace waterfall for the demo scenario spanning all three runtimes; alert rules exported as code in `deploy/observability/`.

### NFR-08 — Security
- **Secrets**: none in Git, images, manifests, or CI logs. Runtime secrets via Infisical Kubernetes Operator → `Secret` objects referenced by `secretKeyRef`; pipeline secrets as GitLab Protected + Masked variables. Services fail fast at startup if a required secret is missing or malformed (§NFR-11).
- **Transport**: Cloudflare terminates public TLS (homelab, per cluster standard); in-cluster traffic is plain HTTP restricted by NetworkPolicies (default-deny per namespace) plus JWT authentication on every internal call (zero-trust at the application layer). Reference production adds mTLS via service mesh.
- **AuthN/Z**: §2.2; RBAC enforced in service layers; least privilege for DB/broker/storage users (§5.7).
- **Input handling**: all external inputs validated by schemas (Zod / Bean Validation / Pydantic) with size limits; raw body size limits at ingress (webhooks 1 MiB, JSON APIs 256 KiB); parameterized SQL only; Mongo queries built from typed filters (no `$where`, operator injection blocked by schema); object keys generated server-side only (path traversal impossible by construction).
- **Web**: strict CORS (console origin only), security headers (CSP `default-src 'self'`, HSTS at Cloudflare, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`), no cookies for auth (Bearer tokens; refresh token in memory + `sessionStorage` fallback documented as a portfolio trade-off).
- **Rate limits**: Cloudflare WAF rules + ingress-nginx `limit-rps` per IP; per-tenant business quotas in owning services (FR-FILE-03, FR-AUTH-01).
- **Supply chain**: pinned base images by digest, SBOM (Syft, CycloneDX) per image, cosign signatures verified at deploy, Trivy/GitLab scanners block Critical/High with no fix-available exceptions tracked in `.trivyignore` with expiry.
- **PII**: synthetic only; masking per §1.4.2; restricted collection access limited to `COMPLIANCE_AUDITOR`.
- **Audit retention**: audit log retained 7 years (no TTL); events per tenant retention; restricted 7 years.
- Evidence: Gitleaks/SAST/Trivy/ZAP reports per pipeline; cross-tenant suite; webhook adversarial suite; NetworkPolicy test (`tests/security/netpol.sh` attempts forbidden connections from a debug pod).

### NFR-09 — Service Layer Supremacy
- All business logic lives in `src/service/` and `src/domain/` of the owning service runtime (TS), `..service`/`..domain` packages (Java), `service/`/`domain/` modules (Python). Gateways, HTTP route adapters, AMQP consumer adapters, CronJob triggers, and webhook receivers parse input, call one service-layer function, and map the result. Workers and adapters never open database, cache, or object-store clients of their own.
- Evidence: architecture tests (NFR-04) + `ci/check-boundaries.sh` grep gate (no `pg`, `mongodb`, `ioredis`, `@aws-sdk/client-s3` imports in `gateway/` or `workers/`).

### NFR-10 — Reliability, Retry & DLQ Policy
- Retry tiers 1 s / 5 s / 30 s (max 3 retries) then DLQ; HTTP client retries only for idempotent calls (max 2, jittered exponential 100 ms base) inside the consumer attempt budget; per-dependency circuit breakers (opossum / Resilience4j / `pybreaker`) with documented thresholds (§6.5).
- Graceful degradation: scanner down → Stage 1 result stands (FR-CLS-06); scoring down → transactions queue in retry/DLQ, no data loss; Mongo down → archive consumer stops acking (prefetch bounds memory), other consumers unaffected.
- Evidence: chaos scenarios (Phase 18) with zero-loss/zero-dup assertions.

### NFR-11 — Startup, Shutdown, Health & Readiness
- Startup order is not assumed: each runtime retries dependency connections with backoff (max 60 s) before failing; readiness gates on (a) config + secrets validated, (b) datastore reachable, (c) schema version ≥ expected migration (Flyway history check / Mongo `schema_meta`), (d) broker topology asserted.
- Probes: `GET /livez` (process alive, no dependency checks), `GET /readyz` (dependencies), `GET /healthz` (aggregated JSON for humans). Liveness never checks dependencies to avoid restart storms.
- Graceful shutdown on `SIGTERM` (terminationGracePeriodSeconds 30): stop accepting HTTP, cancel consumers, finish in-flight messages (≤ 20 s), flush outbox relay batch, flush telemetry, close pools.
- Migrations run as Kubernetes Jobs **before** the Deployment rollout (deploy script waits for Job success); apps never auto-migrate in dev or prod.
- Evidence: rollout logs, `kubectl rollout restart` under load with zero lost messages.

### NFR-12 — Data Durability, Backup & Restore
- PostgreSQL: nightly `pg_dump -Fc` CronJob → object storage `backups/postgres/` (retain 14 daily, 8 weekly) + WAL archiving deferred to production. MongoDB: nightly `mongodump --archive --gzip` → `backups/mongo/`. MinIO bucket versioning on `raw` and `backups`. Redis is a cache/coordination store (AOF on, but losing it only degrades nonce/dedup windows — Postgres uniqueness is the durable guard).
- Backups copied off-node (storage node `optiplex-tower` → another node's disk or an external disk) weekly; a backup that lives only on the storage node's SSD does not count.
- Restore drill each release candidate: restore into `aegispulse-restore-test` namespace, run integrity checks (row counts, audit chain verify). RPO 24 h, RTO 2 h (homelab).
- Evidence: restore drill log in `docs/evidence/`.

### NFR-13 — Schema & Contract Compatibility
- Envelope `schemaVersion` follows SemVer; consumers accept same-major versions and ignore unknown fields; breaking changes require a new major + dual-publish period. AsyncAPI and OpenAPI are validated in CI; `oasdiff`/`asyncapi diff` breaking-change detection blocks MRs without an ADR.
- PostgreSQL migrations are forward-only, expand/contract (add nullable → backfill → enforce) so N-1 code runs against N schema during rollout.
- Evidence: contract job output; migration review checklist in MR template.

### NFR-14 — Type Safety & Code Quality
- TypeScript `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, no `any` (ESLint `@typescript-eslint/no-explicit-any: error`); the gateway alone additionally enables `experimentalDecorators` + `emitDecoratorMetadata` for NestJS DI (ADR-0013); Java with `-Werror` on compiler warnings, NullAway/Error Prone; Python `mypy --strict` + Ruff. Formatters: Prettier, Spotless (google-java-format), Ruff format.
- Evidence: lint/type jobs in CI.

### NFR-15 — Capacity & Resource Limits
- Every container declares CPU/memory requests and limits (§5.4); JVM `-XX:MaxRAMPercentage=50` (measured 2026-11-23: Spring + OTel agent + metaspace ≈ 290 MiB outside the heap, so 70% of a 768Mi limit crash-loops; 50% peaks at 667/768 MiB under Argon2id load); Node `--max-old-space-size` ≤ 75% of limit; Python workers single-process with bounded thread pools.
- Consumer prefetch bounds in-flight memory (§5.5). Body size limits per NFR-08.
- Image layers < 95 MB each (Cloudflare 100 MB edge cap on registry pushes) — `ci/check-layer-sizes.sh`.
- Evidence: CI checks; OOMKilled count = 0 over a 24 h soak.

### NFR-16 — Accessibility & Responsive UI
- Console meets WCAG 2.2 AA; axe-core automated checks in Playwright with zero serious/critical violations; responsive ≥ 360 px.

### NFR-17 — DevOps, IaC & Release
- All cluster resources declared as code in `deploy/k8s/` (Kustomize base + overlays); no `kubectl edit` drift (weekly `kubectl diff` job reports drift).
- Immutable images tagged `$CI_COMMIT_SHORT_SHA` and deployed **by digest**; release tags `vX.Y.Z` promote existing digests (no rebuild). Rollback = redeploy previous digest set (`ci/rollback.sh <git-sha>`), migrations are backward-compatible by NFR-13.
- CI deploys with a namespace-scoped ServiceAccount (never cluster-admin, never the runner SA).
- Evidence: pipeline logs, rollback drill evidence.

### NFR-18 — Environment Behavior Matrix

| Concern | Local | Dev (homelab, `rmwhs-dev.space`) | Prod (homelab, `rmwhs.com`) | Reference production (AWS) |
|---|---|---|---|---|
| Deployed by | `make up` | automatically on every `main` pipeline | manual promotion of dev-verified digests, or `v*` tag | — |
| TLS | none (localhost) | Cloudflare edge | Cloudflare edge | ALB/ACM + mesh mTLS |
| Replicas | 1 | 1 (can scale to zero when idle) | 1 (2 for gateway) | ≥ 2 + HPA |
| Resource requests | n/a | reduced (dev budget §5.4) | full (prod budget §5.4) | autoscaled |
| Secrets | `.env` generated by `make env` (`gen-local-secrets.sh`; never real secrets) | Infisical Operator (env `dev`) | Infisical Operator (env `prod`) | Infisical/AWS Secrets Manager |
| LLM adjudicator | off | opt-in flag (budget $2) | off (opt-in flag) | configurable |
| ClamAV | on (compose) | on | on | on |
| Backups | none | weekly dump, 2 retained | nightly CronJobs (§NFR-12) | managed snapshots + PITR |
| DAST (ZAP baseline + active API scan) | manual | pipeline post-deploy (blocking) | passive baseline only after promotion | pre-prod gate |
| Chaos / load / soak | manual | yes (Phase 18) | **never** | game days |
| Data | synthetic seed | synthetic seed, resettable (`make env-reset ENV=dev`) | demo tenant only, never reset | n/a |
| Demo mode | seed tenant on | all seed tenants | `tenant-acme-capital` only | off |

---

## 4. System Architecture

### 4.1 Architecture Philosophy

AegisPulse separates **transport** from **business logic** in every runtime and every language:

- **Dispatch Layer** — gateways and adapters only: the external HTTP gateway (`gateway/nest-http`), internal HTTP route adapters inside each service (`src/adapters/http/`), AMQP consumer adapters (`src/adapters/amqp/`), scheduled triggers (`workers/scheduler-trigger` CronJobs), the webhook receiver route, and transport mappers. They parse/validate transport input, establish auth context, call exactly one service-layer entrypoint, and map the result to transport output.
- **Orchestration Layer** — application use-case coordinators that live **inside service modules** (`src/service/orchestrators/`, e.g., `ScoreTransactionSaga` in `services/orchestrator`, `CompleteUploadUseCase` in `services/files`). They sequence domain services, repositories, typed clients, and outbox events. Orchestration is not a transport layer and never lives in handlers or consumers.
- **Service Layer** — domain/application services (`src/service/`, `src/domain/`) of named microservices under `services/<bounded-context>/`. Only service runtimes own data stores.

```
> ⚠ Service Layer Supremacy — Core Architectural Rule
> All business logic — validation beyond transport shape, authorization decisions, state
> transitions, scoring, classification, policy, idempotency, persistence, and event publication —
> lives in the service layer of the service runtime that owns the data. Non-service apps
> (the gateway, workers, HTTP handlers/controllers, AMQP consumers, schedulers, webhook receivers)
> NEVER open direct database, cache, or object-storage connections (PostgreSQL, MongoDB, Redis,
> S3/MinIO) and must call service APIs/contracts (typed clients over internal HTTP) for every data
> mutation and retrieval. Inside a service runtime, adapters call the service layer in-process;
> repositories are called only by the service layer. A handler that contains an `if` about
> business state is a defect.
```

Additional principles:
1. **Polyglot by boundary, not by fashion** — Node.js for I/O-bound edge, ingestion, files, events and saga orchestration; Java/Spring Boot for strongly-typed domain state (identity/RBAC, case workflow, audit); Python for documents, ML, NLP, analytics (ADR-0001).
2. **Data ownership** — each datastore schema/collection/keyspace/bucket prefix has exactly one owning service (§5.7). Cross-service data access is API-only.
3. **Lean messaging** — binaries never traverse RabbitMQ; events carry `fileId`/`storageKey`/`sha256` pointers (ADR-0009). Max message size 256 KiB (enforced by publisher kit).
4. **Outbox-first publication** — state change and event emission are atomic (ADR-0004).
5. **Elevate-only automated classification** with full lineage (ADR-0008).

### 4.2 Production Architecture (Reference — not provisioned)

```
                    Internet
                        │
              ┌─────────▼──────────┐
              │ Route 53 + CloudFront (console)  │
              │ AWS WAF (managed + rate rules)   │
              └─────────┬──────────┘
                        │ HTTPS
              ┌─────────▼──────────┐
              │ ALB (AWS LB Controller, ACM TLS) │
              └─────────┬──────────┘
┌───────────────────────┼─────────────────────────────── EKS (3 AZ, Karpenter) ─────────────┐
│  Istio/Linkerd mTLS   │                                                                   │
│        ┌──────────────▼──────────────┐                                                    │
│        │ gateway (HPA 3–10)          │──JWT──▶ registry (Spring Boot, 2–4)                │
│        └──────┬───────────┬──────────┘                                                    │
│               │ typed HTTP │                                                              │
│   ingestion(3+) files(3+) events(3+) cases(3+) orchestrator(3+) risk-scoring(2+)          │
│   sensitivity-scanner(2+) doc-extraction(KEDA 1–20 on queue depth) data-intel(2)          │
│                                                                                           │
└──────┬──────────────┬──────────────┬──────────────┬──────────────┬────────────────────────┘
       │              │              │              │              │
  Amazon RDS     MongoDB Atlas   Amazon MQ      ElastiCache      Amazon S3
  PostgreSQL     (M30, 3-node    (RabbitMQ       (Valkey/Redis,   (raw, artifacts,
  Multi-AZ +     replica set,    cluster, 3      cluster mode,    quarantine, archive,
  PITR, read     PITR)           brokers, Multi-  Multi-AZ)       analytics; SSE-KMS,
  replica                        AZ)                              Object Lock on audit
                                                                   exports)
  Observability: OpenObserve (or Grafana Cloud) via OTel Collector DaemonSet
  Secrets: Infisical (HA) or AWS Secrets Manager via External Secrets; KMS for KEKs
  Supply chain: ECR + cosign verification via Kyverno admission policies
```

**Why this in production:** managed Multi-AZ datastores remove single-node failure modes; KEDA scales extraction on queue depth (bursty filings); ALB + WAF gives managed L7 protection; service-mesh mTLS adds transport-level zero-trust on top of JWT; Kyverno enforces signed images at admission.

### 4.3 Portfolio Architecture (Homelab k3s — deployed)

```
Internet ─▶ Cloudflare (TLS, WAF, 100 MB body cap) ─▶ cloudflared tunnel
                                                        │ plain HTTP
                                         ingress-nginx (class nginx-external)
          Host-based routing (same tunnel, same ingress controller, two domains):
   PROD  aegispulse.rmwhs.com        aegispulse-api.rmwhs.com        aegispulse-objects.rmwhs.com      → ns aegispulse
   DEV   aegispulse.rmwhs-dev.space  aegispulse-api.rmwhs-dev.space  aegispulse-objects.rmwhs-dev.space → ns aegispulse-dev
         (console, nginx static)     (gateway)                       (object store S3 API, presigned only)
┌──────────── namespace: aegispulse (prod)  ·  namespace: aegispulse-dev (dev, same shape, reduced) ─────────────┐
│ COMPUTE TIER: NODE optiplex (worker, preferred) → spill-over NODE elitedesk-800          │
│   gateway ─▶ ingestion · files · events · registry · cases · orchestrator                │
│             risk-scoring · sensitivity-scanner · doc-extraction · data-intel · clamav    │
│   CronJobs: scheduler-trigger (connectors, sweeps, rollups), backups, audit-verify       │
│ STORAGE TIER: NODE optiplex-tower (dedicated=storage taint; 1 TB SSD at local-path dir)  │
│   postgresql-18 · mongodb-8 (1-node replica set) · redis-8 · object-store (S3 API)       │
└───────────────────────────────────────────┬──────────────────────────────────────────────┘
      shared cluster services: rabbitmq (vhosts aegispulse-prod, aegispulse-dev) · infisical (+ operator; envs prod, dev)
      openobserve (logs/metrics/traces) · trivy-operator · gitlab + runner (kaniko)
      uptime-kuma + ntfy (installed in Phase 18 if absent)
```

| Concern | Production (reference) | Portfolio (homelab dev + prod) |
|---|---|---|
| Compute | EKS, 3 AZ, HPA/KEDA/Karpenter | k3s, 3 nodes with fixed roles (ADR-0015), fixed capacity, replicas 1 (gateway 2) |
| Ingress/TLS | ALB + ACM + WAF, mesh mTLS | Cloudflare edge TLS/WAF → tunnel → ingress-nginx (HTTP); JWT on every hop |
| PostgreSQL | RDS Multi-AZ + PITR | single StatefulSet on optiplex-tower, nightly dumps |
| MongoDB | Atlas 3-node | single-member replica set (transactions enabled) |
| RabbitMQ | Amazon MQ cluster | shared in-cluster broker, dedicated vhost, quorum queues |
| Redis | ElastiCache Multi-AZ | single StatefulSet, AOF |
| Object storage | S3 + KMS + Object Lock | S3-compatible store on optiplex-tower (ADR-0011), versioning on |
| Secrets | Secrets Manager/Infisical HA + KMS | self-hosted Infisical + Operator |
| Registry | ECR | GitLab Container Registry (`registry.rmwhs.com`) |
| Image policy | Kyverno verify-images | cosign verify in deploy script |
| Observability | OTel Collector + managed backend | OpenObserve in cluster |
| Availability | 99.9% target | best effort; single points of failure accepted and documented |
| Environments | separate AWS accounts per env | two namespaces on one cluster, separated by domain, NetworkPolicy, credentials, and datastores (ADR-0014) |

### 4.4 Async Event Flows

#### 4.4.1 Webhook → Archive → Classification → Correlation
```
POST /webhooks/{sourceKey}
  → [gateway] raw-body passthrough → ingestion.ingestWebhookDelivery
      → [Ingestion service] verifySignature → checkSkew → claimNonce(Redis)
          ├─ reject → 401/409/404/422 (metric + log, no event)
          └─ accept → putRawPayload(S3) → TX{ insert delivery; insert outbox(external.*) } → 202
  → [Ingestion outbox relay] publish aegispulse.ingress / external.<category> (confirm) → mark sent
      → events.archive.q → [Events archive consumer] → archiveEvent()
          → Stage1 rules → TX{ insert archive doc; outbox(classification.scan.requested) }
      → events.classification.q → [Events] runAiScan() → scanner.scan()
          ├─ ok → TX{ patch AI_SCANNED→CLASSIFIED; outbox(classification.finalized) }
          └─ circuit open → leave RULE_SCANNED, pendingAiScan=true (sweep later)
      → orchestrator.correlation.q (classification.finalized, final ≥ HIGH)
          → [ClassifiedSignalSaga] registry.resolveEntities → registry.checkWatchlists
              ├─ open cases on entities → cases.reevaluateOpenCases → ENRICHING → POLICY_EVALUATED → ESCALATED|CLEARED
              └─ watchlist hit, no case → cases.openCase(DOCUMENT_RISK)
```

#### 4.4.2 Transaction Scoring
```
POST /v1/transactions
  → [gateway] → ingestion.submitTransaction → TX{ insert submission; outbox(txn.submitted) } → 202
  → orchestrator.txn.q → [ScoreTransactionSaga]
      → registry.checkWatchlists(counterparty)
      → riskScoring.score()  (2 s timeout, breaker)
      → cases.recordRiskEvaluation(idempotencyKey=risk-eval:{eventId})
          ├─ score < 70 → TX{ evaluation; outbox(risk.evaluation.recorded) }
          └─ score ≥ 70 → TX{ evaluation; case OPEN→ENRICHING; audit; outbox(risk.evaluation.recorded, case.opened) }
                → enrichment timer (10 min) / evidence → POLICY_EVALUATED
                    ├─ ESCALATED (≥75) → outbox(case.escalated, correlation.requested[, notification.requested N-01])
                    └─ CLEARED
  → orchestrator.correlation-request.q → [CaseCorrelationSaga] → events.searchEventsForEntities → cases.attachEvidence
```

#### 4.4.3 File Upload → Validation → Extraction
```
POST /v1/files/uploads/init → [Files] dedup? quota? → TX{ files INITIATED } → Redis session → presigned PUT
client PUT → aegispulse-objects.rmwhs.com (signature-verified by object store)
POST /v1/files/uploads/{id}/complete → [Files] HEAD object, size check → TX{ UPLOADED; outbox(file.uploaded, file.status.changed) }
  → files.validation.q → [Files validateFile]
      ├─ pass → TX{ VALIDATED; outbox(doc.file.ready, file.status.changed) }
      ├─ checksum/size mismatch → FAILED
      └─ AV/MIME → move to quarantine/ → QUARANTINED → outbox(notification.requested N-03)
  → doc.extraction.q → [Doc Extraction] files.markProcessing → download(presigned GET) → parse → extract
      ├─ TRANSACTION_BATCH → ingestion.submitTransactionBatch (chunks) → files.recordExtractionResult(rows)
      ├─ confidence ≥ 0.70 → write artifacts → files.recordExtractionResult(COMPLETED)
      │     → TX{ PROCESSED; outbox(doc.extraction.completed) } → archive/classify/correlate as 4.4.1
      └─ < 0.70 → files.recordExtractionResult(REVIEW_REQUIRED) → outbox(doc.extraction.review_required)
            → orchestrator.review.q → cases.openCase(EXTRACTION_REVIEW)
```

#### 4.4.4 Retry & Dead-Letter Flow
```
consumer handler throws
  → [consumer kit] classify error
      ├─ TRANSIENT & x-retry-count < 3 → publish aegispulse.retry / {queue}.retry.{1s|5s|30s} → ack original
      │     → TTL expires → dead-letter to default exchange → routing key {queue} → redelivered
      └─ PERMANENT | POISON | retries exhausted → publish aegispulse.dlx / {queue} → {queue}.dlq → ack original
            → events.deadletter.q → [Events recordDeadLetter] → Mongo dead_letters → outbox(ops.dead_letter.recorded)
                → OpenObserve alert (threshold) → ntfy N-04
```

#### 4.4.5 Replay
```
POST /v1/events/replay → [Events] validate filter + RBAC → replay_jobs PENDING → 202
  → [Events replay runner] (single active runner via Mongo lease) RUNNING
      → cursor over archive (occurredAt asc) → publish with x-aegis-replay-job/generation (≤ 200 msg/s, confirms)
      → checkpoint every 100 → COMPLETED | CANCELLED | FAILED → audit via outbox(ops.replay.completed)
```

#### 4.4.6 Data Intelligence
```
intel.facts.q (many routing keys) → [Data Intel recordFact] → TX{ fact row; processed_messages }
CronJob */15 → scheduler-trigger → data-intel POST /internal/v1/rollups:run (scope=today)
CronJob 02:00 UTC → rollups (scope=yesterday) → drift checks → TX{ drift_metrics; outbox(intel.drift.detected, notification.requested) }
case.disposition.recorded → precision facts → GET /v1/intel/precision
```

### 4.5 Local Development Architecture

```
developer laptop
  docker compose (deploy/compose/docker-compose.yml)
    infra:    postgres:18 · mongo:8 (rs0) · redis:8 · rabbitmq:4-management · object-store (S3 API)
              clamav · openobserve · flyway-migrate (one-shot per schema) · mongo-init
    services: gateway · ingestion · files · events · registry · cases · orchestrator
              risk-scoring · sensitivity-scanner · doc-extraction · data-intel · console (vite)
  `make dev SERVICE=<name>` stops that container and runs the service natively with hot reload
  against the same compose dependencies (ports §10.3).
  scheduler-trigger jobs are invoked manually: `make trigger JOB=connectors-run-due`.
  Optional parity mode: `make k3d-up` deploys deploy/k8s/overlays/k3d-local to a local k3d cluster.
```


---

## 5. Infrastructure & Resources (Homelab k3s + Reference AWS)

> Template adaptation: the portfolio target is the existing homelab k3s cluster defined in [docs/K3S_CONTEXT.md](docs/K3S_CONTEXT.md), not AWS Lambda. This section is the IaC source of truth for `deploy/k8s/`. AWS appears only as the reference production mapping (§5.8). The cluster's hard requirements (subdomain-only ingress, `nginx-external`, GitLab-only CI, registry images by SHA, namespace per app, requests/limits everywhere, no privileged containers, no committed secrets, storage-node pinning) are binding.

### 5.1 Resource Naming Convention

Pattern: `aegispulse-{component}[-{descriptor}]`.

| Kind | Example |
|---|---|
| Namespace | `aegispulse` (prod), `aegispulse-dev` (dev); restore drills: `aegispulse-restore-test` |
| Deployment / Service | `aegispulse-gateway`, `aegispulse-cases` |
| StatefulSet | `aegispulse-postgres`, `aegispulse-mongo`, `aegispulse-redis`, `aegispulse-objectstore` |
| CronJob | `aegispulse-cron-connectors`, `aegispulse-cron-file-sweep`, `aegispulse-cron-rollups-15m`, `aegispulse-cron-rollups-nightly`, `aegispulse-cron-backup-postgres`, `aegispulse-cron-backup-mongo`, `aegispulse-cron-audit-verify`, `aegispulse-cron-retention`, `aegispulse-cron-secret-expiry` (hourly, job `ingestion-secret-expiry`, FR-WHK-08) |
| Migration Job | `aegispulse-migrate-{service}-{shortsha}` |
| ServiceAccount | `aegispulse-{component}` (+ `aegispulse-ci-deployer`) |
| Secret (Infisical-managed) | `aegispulse-{component}-secrets` |
| ConfigMap | `aegispulse-{component}-config` |
| NetworkPolicy | `aegispulse-{component}-ingress`, `aegispulse-default-deny` |
| Ingress | `aegispulse-console`, `aegispulse-api`, `aegispulse-objects` |
| Buckets | `aegispulse-{dev\|prod}-raw`, `-artifacts`, `-quarantine`, `-archive`, `-analytics`, `-backups` (each in its namespace's own object store) |
| RabbitMQ | vhosts `aegispulse-dev`, `aegispulse-prod`; exchanges `aegispulse.{ingress,enrichment,domain,intelligence,retry,dlx}`; queues `{owner}.{purpose}.q` |
| OpenObserve | streams `aegispulse_{dev\|prod}_logs`, `_traces`, `_metrics` |
| Hostnames | `aegispulse[-api\|-objects].rmwhs.com` (prod), `aegispulse[-api\|-objects].rmwhs-dev.space` (dev). Always one label under the domain (Cloudflare Universal SSL covers first-level subdomains only) |

### 5.2 Standard Labels & Annotations

```yaml
metadata:
  labels:
    app.kubernetes.io/name: aegispulse-gateway
    app.kubernetes.io/component: gateway        # gateway|service|worker|datastore|cronjob|migration|frontend
    app.kubernetes.io/part-of: aegispulse
    app.kubernetes.io/version: "<git-short-sha>"
    app.kubernetes.io/managed-by: kustomize
    aegispulse.io/runtime: node                 # node|java|python|static|datastore
    aegispulse.io/tier: stateless               # stateless|storage
  annotations:
    aegispulse.io/owner: ryan-waite
    aegispulse.io/spec: "PROJECT.md#54-workload-configuration"
```

### 5.3 Resources Used

| Category | Resource | Purpose |
|---|---|---|
| Namespace | `aegispulse` (prod) | prod workloads; `ResourceQuota` (requests.cpu 3.5, requests.memory 9Gi, limits.memory 18Gi) + `LimitRange` defaults |
| Namespace | `aegispulse-dev` (dev) | dev workloads; `ResourceQuota` (requests.cpu 1.5, requests.memory 5Gi, limits.memory 10Gi) + `LimitRange` defaults |
| Ingress | `aegispulse-console` → `aegispulse.rmwhs.com` (prod) / `aegispulse.rmwhs-dev.space` (dev) | console static site |
| Ingress | `aegispulse-api` → `aegispulse-api.rmwhs.com` (prod) / `aegispulse-api.rmwhs-dev.space` (dev) | gateway (incl. `/webhooks/*`, SSE with `proxy-buffering: off`, `proxy-read-timeout: 3600`) |
| Ingress | `aegispulse-objects` → `aegispulse-objects.rmwhs.com` (prod) / `aegispulse-objects.rmwhs-dev.space` (dev) | object store S3 API for presigned PUT/GET only (`proxy-body-size: 100m`) |
| Deployments | 12 (§5.4) | application runtimes |
| StatefulSets | postgres, mongo, redis, objectstore | data stores pinned to the storage node `optiplex-tower` (`dedicated: storage`) |
| CronJobs | 9 (§5.1) | schedules via `workers/scheduler-trigger` and backup images |
| Jobs | per-service Flyway migrations, Mongo index migrations, RabbitMQ topology assert, seed (dev: all seed tenants; prod: demo tenant only) | pre-rollout |
| PVCs (`local-path`) | postgres 20Gi, mongo 20Gi, redis 1Gi, objectstore 60Gi, clamav-db 2Gi (`optiplex`, required worker affinity) | persistent data; storage-tier PVs live on `optiplex-tower`'s data SSD |
| NetworkPolicies | default-deny ingress+egress; explicit allows (§5.7.5) | zero-trust network |
| InfisicalSecret CRs | one per component | runtime secret sync |
| RabbitMQ (shared) | vhost, users, policies (quorum queues, max-length on DLQs 100k) | messaging |
| Infisical (shared) | org HomeLab, project AegisPulse, envs Development/Production; `svc_admin` (org machine identity) for workstation bootstrap/rotation only; operator identities `aegispulse-operator-dev`/`-prod`, each read-only to its env via Kubernetes Auth (MB-08) | secrets |
| OpenObserve (shared) | org `aegispulse`, streams, alerts, dashboards | observability |
| GitLab | project, protected branches/tags, CI variables, container registry | CI/CD |
| Cloudflare | 6 proxied DNS records (3 per domain) + tunnel public hostnames, WAF rate rule on `/webhooks/*` and `/v1/auth/*` | edge |
| Uptime Kuma + ntfy | monitors (§9.7), topics `aegispulse-alerts` / `aegispulse-alerts-dev` | synthetic checks + push |

### 5.4 Workload Configuration

All containers: `runAsNonRoot: true`, `readOnlyRootFilesystem: true` (writable `emptyDir` at `/tmp` only), `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`, `automountServiceAccountToken: false`. Probes: liveness `/livez` (period 10 s, failure 3), readiness `/readyz` (period 5 s, failure 2), startup `/livez` (failure 30 × 2 s; JVM 60 × 2 s).

| Workload | Runtime | Port | Replicas (prod) | CPU req/lim (prod) | Mem req/lim (prod) | Node | Trigger |
|---|---|---|---|---|---|---|---|
| `aegispulse-gateway` | Node 24 | 8080 | 2 | 100m / 500m | 128Mi / 384Mi | compute | Ingress |
| `aegispulse-ingestion` | Node 24 | 8081 | 1 | 100m / 500m | 128Mi / 384Mi | compute | HTTP + outbox relay |
| `aegispulse-files` | Node 24 | 8082 | 1 | 100m / 500m | 128Mi / 384Mi | compute | HTTP + AMQP |
| `aegispulse-events` | Node 24 | 8083 | 1 | 100m / 500m | 192Mi / 512Mi | compute | AMQP + HTTP |
| `aegispulse-registry` | Java 25 | 8084 | 1 | 200m / 1000m | 384Mi / 768Mi | compute | HTTP |
| `aegispulse-cases` | Java 25 | 8085 | 1 | 200m / 1000m | 384Mi / 768Mi | compute | HTTP + AMQP |
| `aegispulse-risk-scoring` | Python 3.13 | 8086 | 1 | 100m / 500m | 192Mi / 512Mi | compute | HTTP |
| `aegispulse-scanner` | Python 3.13 | 8087 | 1 | 100m / 1000m | 384Mi / 1Gi | compute | HTTP |
| `aegispulse-doc-extraction` | Python 3.13 | 8088 | 1 | 200m / 1500m | 512Mi / 1536Mi | compute | AMQP |
| `aegispulse-data-intel` | Python 3.13 | 8089 | 1 | 100m / 500m | 256Mi / 768Mi | compute | AMQP + HTTP |
| `aegispulse-orchestrator` | Node 24 | 8090 | 1 | 50m / 500m | 128Mi / 256Mi | compute | AMQP |
| `aegispulse-console` | nginx-unprivileged | 8080 | 1 | 20m / 100m | 32Mi / 64Mi | compute | Ingress |
| `aegispulse-clamav` | clamd | 3310 | 1 | 100m / 500m | 1Gi / 1536Mi | compute | TCP (files only) |
| CronJobs (each) | Node 24 / tool images | — | — | 50m / 250m | 64Mi / 256Mi | compute | schedule |
| `aegispulse-postgres` | PostgreSQL 18 | 5432 | 1 | 250m / 1000m | 512Mi / 1536Mi | storage | — |
| `aegispulse-mongo` | MongoDB 8 | 27017 | 1 | 250m / 1000m | 768Mi / 1536Mi | storage | — |
| `aegispulse-redis` | Redis 8 | 6379 | 1 | 50m / 250m | 64Mi / 256Mi | storage | — |
| `aegispulse-objectstore` | SeaweedFS 4.54 (S3 API) | 8333 | 1 | 100m / 500m | 256Mi / 768Mi | storage | — |

Node column: **compute** = `optiplex` preferred (`preferredDuringScheduling` weight 100 on `node-role.kubernetes.io/worker=true`), spilling to `elitedesk-800`; ClamAV uses a *required* worker affinity so its PVC binds deterministically. **storage** = `optiplex-tower` (ADR-0015).

Budget totals (prod requests): compute tier ≈ 1.77 vCPU / 4.4 GiB (gateway ×2 counted); storage tier ≈ 0.65 vCPU / 1.6 GiB — within NFR-03.

**Dev sizing (`overlays/dev`, namespace `aegispulse-dev`).** Same workloads and images with replicas 1 everywhere (gateway 1) and halved requests. **Limits stay identical to prod** so dev catches OOM and throttling issues that prod would hit. Examples: Node services 50m/96Mi, Java services 100m/256Mi, scanner 50m/256Mi, doc-extraction 100m/384Mi, ClamAV 50m/768Mi, data stores postgres 100m/256Mi, mongo 100m/384Mi, redis 25m/48Mi, objectstore 50m/128Mi. PVCs: postgres 5Gi, mongo 5Gi, redis 1Gi, objectstore 15Gi. Dev totals ≈ 0.9 vCPU / 2.9 GiB (compute tier) and 0.3 vCPU / 0.8 GiB (storage tier), within the dev budget (NFR-03). Dev may be scaled to zero when idle (`env:sleep:dev`). **Capacity watch:** prod + awake dev ≈ 2.7 vCPU of CPU requests, which now lands first on `optiplex`'s 4 vCPU (dedicated to app pods) rather than on `elitedesk-800` alongside GitLab and platform services (ADR-0015). Phase 9 records `kubectl describe node` allocations for both compute nodes, and if CPU requests exceed 85% of the compute tier's allocatable, dev defaults to sleeping outside pipeline runs. Storage StatefulSets carry the `dedicated: storage` nodeSelector **and** the `dedicated=storage:NoSchedule` toleration on first deploy; no other workload tolerates that taint.

### 5.5 RabbitMQ Queue Configuration

All queues are **quorum** queues (`x-queue-type: quorum`), durable, with `x-delivery-limit: 10` as a backstop. Retry queues are classic durable queues with `x-message-ttl` and `x-dead-letter-exchange: ""`, `x-dead-letter-routing-key: {queue}`. The retry-tier column is the per-attempt delay plan; one retry queue `{queue}.retry.{delay}` exists per **distinct** delay (e.g. `doc.extraction.q` 5s/30s/30s uses two queues). DLQs: `x-max-length: 100000`, `overflow: reject-publish`.

| Queue | Owner (consumer) | Bindings (exchange → routing key) | Prefetch | Retry tiers | DLQ |
|---|---|---|---|---|---|
| `events.archive.q` | events | ingress/enrichment/domain/intelligence → `#` | 50 | 1s/5s/30s | `events.archive.q.dlq` |
| `events.classification.q` | events | enrichment → `classification.scan.requested` | 5 | 1s/5s/30s | `.dlq` |
| `events.deadletter.q` | events | dlx → `#` (all `*.dlq` copies; see note) | 20 | none (store-or-requeue) | — |
| `files.validation.q` | files | ingress → `file.uploaded` | 4 | 1s/5s/30s | `.dlq` |
| `doc.extraction.q` | doc-extraction | enrichment → `doc.file.ready` | 2 | 5s/30s/30s | `.dlq` |
| `orchestrator.txn.q` | orchestrator | ingress → `txn.submitted` | 20 | 1s/5s/30s | `.dlq` |
| `orchestrator.correlation.q` | orchestrator | enrichment → `classification.finalized` | 10 | 1s/5s/30s | `.dlq` |
| `orchestrator.correlation-request.q` | orchestrator | domain → `correlation.requested` | 10 | 1s/5s/30s | `.dlq` |
| `orchestrator.review.q` | orchestrator | enrichment → `doc.extraction.review_required` | 10 | 1s/5s/30s | `.dlq` |
| `orchestrator.notify.q` | orchestrator | domain/enrichment/intelligence → `notification.requested` | 10 | 1s/5s/30s | `.dlq` |
| `cases.audit-ingest.q` | cases | domain → `registry.#`; enrichment → `classification.overridden`; intelligence → `ops.replay.*`, `ops.audit.*` | 20 | 1s/5s/30s | `.dlq` |
| `cases.enrichment-timer.q` | cases | delayed self-messages: publish to `aegispulse.retry` with key `cases.enrichment-timer.q.delay.10m` (TTL 10 min queue dead-letters to this queue) | 10 | — | `.dlq` |
| `intel.facts.q` | data-intel | domain → `risk.evaluation.recorded`, `case.#`; enrichment → `classification.finalized`, `classification.overridden`, `doc.extraction.#`, `file.status.changed`; intelligence → `ops.dead_letter.recorded` | 50 | 1s/5s/30s | `.dlq` |
| `gateway.sse.{podId}` | gateway | domain → `case.#`, `risk.evaluation.recorded`; enrichment → `file.status.changed`, `classification.finalized`, `doc.extraction.#` | 100 | none (exclusive, auto-delete, `x-max-length 1000`, drop-head) | — |

Dead-letter routing note: `{queue}.dlq` queues are bound to `aegispulse.dlx` with routing key `{queue}`; `events.deadletter.q` is bound to the same exchange with `#`, so every dead letter is both retained in its DLQ (for broker-level inspection) and recorded in Mongo. The registry consumer never re-dead-letters: on failure it retries in process with capped backoff (5 s doubling to 60 s) while holding the delivery, and only after 20 min (or on shutdown) nacks with requeue, so the `x-delivery-limit` backstop is reached only after ~10 × 20 min of store outage.

### 5.6 Datastore Configuration

| Setting | Portfolio (homelab) | Production (reference) |
|---|---|---|
| PostgreSQL | 18, single StatefulSet, `shared_buffers=256MB`, `max_connections=120`, `work_mem=8MB`, extensions `pgcrypto`, `pg_trgm`, `citext` | RDS PostgreSQL 18 `db.m7g.large` Multi-AZ, 200 GB gp3, PITR 14 d, Performance Insights, RDS Proxy |
| Postgres layout | DB `aegispulse`; schemas `ingestion`, `files`, `registry`, `cases`, `analytics`; one owner role + one app role per schema | same, optional split per service DB |
| Pooling | per-service pool max 10 (Node `pg`), Hikari 10 (Java), SQLAlchemy 5 (Python) | RDS Proxy |
| MongoDB | 8.0, single-member replica set `rs0` (transactions), WiredTiger cache 0.5 GB, auth enabled | Atlas M30 3-node, PITR, encryption at rest |
| Redis | 8, AOF `everysec`, `maxmemory 192mb`, `allkeys-lru` disabled → `volatile-ttl` (all keys have TTL), ACL users per service | ElastiCache Multi-AZ, TLS, AUTH |
| RabbitMQ | shared cluster broker 4.x, vhosts `aegispulse-dev` / `aegispulse-prod`, Prometheus plugin | Amazon MQ for RabbitMQ cluster deployment |
| Object store | S3-compatible single node, versioning on `raw`/`backups`, lifecycle: `quarantine/` 30 d, `tmp/` 1 d | S3 SSE-KMS, Object Lock (governance) on `backups` |
| Backups | prod: nightly dumps → `aegispulse-prod-backups`, weekly off-node copy; dev: weekly dump → `aegispulse-dev-backups` (2 retained) | managed snapshots + cross-region copy |

### 5.7 Identity, Least Privilege & Network Policy

#### 5.7.1 Kubernetes ServiceAccounts
- One ServiceAccount per workload, `automountServiceAccountToken: false` (no workload talks to the Kubernetes API).
- `aegispulse-ci-deployer`: one per namespace (`aegispulse`, `aegispulse-dev`), each a Role scoped to its own namespace, allowing `get/list/watch/create/update/patch` on Deployments, StatefulSets, Services, Ingresses, ConfigMaps, Jobs, CronJobs, NetworkPolicies, ServiceAccounts, PDBs, `InfisicalSecret` CRs; `delete` on Jobs only; **no** access to `Secret` objects (Infisical Operator manages them). Tokens stored as masked/protected GitLab variables `AEGIS_DEPLOY_SA_TOKEN_DEV` and `AEGIS_DEPLOY_SA_TOKEN_PROD` (the prod variable is scoped to the GitLab `prod` environment only).

#### 5.7.2 PostgreSQL Roles
| Role | Grants |
|---|---|
| `mig_{schema}` (×5) | owner of its schema; used only by migration Jobs |
| `svc_ingestion` | DML on `ingestion.*` |
| `svc_files` | DML on `files.*` |
| `svc_registry` | DML on `registry.*` |
| `svc_cases` | `SELECT, INSERT, UPDATE` on `cases.*` except `audit_log` (`SELECT, INSERT` only) |
| `svc_analytics` | DML on `analytics.*` (data-intel's runtime role; roles follow `svc_{schema}`) |
| `{schema}_platform` (×5) | `NOLOGIN BYPASSRLS`; owns only the migration-defined `SECURITY DEFINER` functions for cross-tenant operations, with the table privileges they need; `mig_{schema}` is a member `WITH INHERIT FALSE, SET TRUE` (to assign ownership); created by the DB bootstrap (superuser), ADR-0016 |
| `backup_reader` | `pg_read_all_data` (backup CronJob only) |
No role has cross-schema privileges; RLS enabled with `FORCE ROW LEVEL SECURITY` on tenant tables; no `svc_*` role can bypass RLS (ADR-0016).

#### 5.7.3 MongoDB, Redis, RabbitMQ, Object Store Principals
| Principal | Scope |
|---|---|
| Mongo `svc_events` | `readWrite` on DB `aegispulse_events` (no `dbAdmin`: cannot alter validators/indexes) |
| Mongo `mig_events` | `readWrite` + `dbAdmin` on `aegispulse_events`; used only by migrate-mongo (Job / `make migrate`) |
| Mongo `backup` | `backup` role |
| Redis ACL `ingestion` | `~whk:* ~idem:ingestion:* +@read +@write +@string -@dangerous` |
| Redis ACL `files` | `~upload:* ~file:* ~quota:files:*` |
| Redis ACL `risk_scoring` | `~feat:*` |
| Redis ACL `registry` | `~auth:* ~ratelimit:auth:*` |
| RabbitMQ user per service | configure: `^$` (topology asserted by migration Job user `aegis_topology`), write: owning exchanges + `aegispulse.retry` + `aegispulse.dlx`, read: own queues only |
| Object store `files` | `raw/*`, `quarantine/*`; `artifacts/*` read, plus delete for the FR-FILE-12 retention purge; presign rights |
| Object store `ingestion` | `aegispulse-{env}-raw/raw/webhooks/*` read, write (incl. delete) and list, prefix-scoped (FR-WHK-08 orphan sweep) |
| Object store `doc_extraction` | `artifacts/*` write; reads raw only via Files-issued presigned URLs |
| Object store `events` | `aegispulse-{env}-archive/*` write |
| Object store `data_intel` | `aegispulse-{env}-analytics/*` RW |
| Object store `backup` | `aegispulse-{env}-backups/*` write |

#### 5.7.4 Internal Service Action Allowlist (`act[]` claim)
| Caller (SERVICE account) | Allowed callee actions |
|---|---|
| gateway | all public-route actions on behalf of the user (forwards the user JWT). Uses its **own SERVICE token** only where no user token can exist yet: `registry.login`, `registry.refreshToken`, `ingestion.ingestWebhookDelivery` (HMAC-verified by ingestion), plus `/.well-known/jwks.json` and health |
| orchestrator | `registry.resolveEntities`, `registry.checkWatchlists`, `registry.getTenantSettings`, `riskScoring.score`, `cases.recordRiskEvaluation`, `cases.reevaluateOpenCases`, `cases.openCase`, `cases.attachEvidence`, `events.searchEventsForEntities` |
| ingestion | `files.registerRemoteFile`, `registry.getTenantSettings` |
| files | `registry.getTenantSettings` |
| events | `scanner.scan`, `registry.getTenantSettings` |
| doc-extraction | `files.markProcessing`, `files.getInternalDownloadUrl`, `files.recordExtractionResult`, `files.recordProcessingFailure`, `ingestion.submitTransactionBatch`, `registry.resolveEntities` |
| risk-scoring | — |
| data-intel | `registry.getTenantSettings` |
| scheduler-trigger | `ingestion.runDueConnectors`, `ingestion.expirePreviousSecrets`, `files.sweepOrphans`, `files.purgeRetention`, `events.sweepPendingScans`, `events.purgeRetention`, `cases.runEnrichmentTimeouts`, `cases.autoResolveCleared`, `cases.verifyAuditChain`, `dataIntel.runRollups`, `dataIntel.runDriftChecks`, `dataIntel.exportParquet` |

#### 5.7.5 NetworkPolicies (default deny, explicit allow)
- Identical policy sets in `aegispulse` and `aegispulse-dev`. Every allow rule selects pods **within its own namespace** (or named platform namespaces below). There are no rules between `aegispulse-dev` and `aegispulse`, so dev pods can't reach prod pods or datastores, and the reverse.
- Ingress to gateway and console only from `ingress-nginx` namespace; objectstore port 9000 from `ingress-nginx` (presigned) and from files/ingestion/doc-extraction/events/data-intel/backup.
- Service ingress (8081–8090) only from gateway, orchestrator, scheduler CronJobs, and the specific callers in §5.7.4.
- Datastore ingress only from owners: postgres ← ingestion, files, registry, cases, data-intel, migration Jobs, backup; mongo ← events, mongo-migrate, backup; redis ← ingestion, files, registry, risk-scoring; clamav ← files.
- Egress: all pods → kube-dns; → `rabbitmq` namespace 5672 (messaging services + gateway); → `openobserve` OTLP 5080; ingestion + files → internet 443 (connectors/attachments; SSRF guard in code); orchestrator → ntfy; scanner → LLM provider 443 only when `SCANNER_LLM_ENABLED`.

### 5.8 Reference Production Mapping (AWS)

| Homelab component | AWS production equivalent |
|---|---|
| k3s 2-node | EKS 1.x, 3 AZ, managed node groups + Karpenter |
| ingress-nginx + Cloudflare Tunnel | AWS Load Balancer Controller (ALB) + ACM + WAF; CloudFront for console |
| PostgreSQL StatefulSet | RDS PostgreSQL Multi-AZ + RDS Proxy |
| MongoDB StatefulSet | MongoDB Atlas on AWS (PrivateLink) |
| Shared RabbitMQ | Amazon MQ for RabbitMQ (cluster) |
| Redis StatefulSet | ElastiCache (Valkey/Redis OSS) Multi-AZ |
| S3-compatible store | S3 (SSE-KMS, Object Lock, lifecycle to Glacier for archive) |
| Infisical Operator | Infisical HA or AWS Secrets Manager + External Secrets Operator; KMS-wrapped KEKs |
| GitLab registry | ECR with image scanning |
| OpenObserve | OpenObserve HA / Amazon Managed Prometheus + Grafana + X-Ray (via OTel) |
| CronJobs | Kubernetes CronJobs (unchanged) or EventBridge Scheduler |
| IaC | Terraform modules (`infra/terraform/aws-reference/`, documentation-grade, not applied) |

### 5.9 DNS & Edge
- Cloudflare proxied records → the same tunnel: `aegispulse`, `aegispulse-api`, `aegispulse-objects` under `rmwhs.com` (**prod**) and under `rmwhs-dev.space` (**dev**). No apex binding on either domain, and hostnames stay one label deep so Universal SSL covers them.
- ingress-nginx routes by `Host`: each namespace's Ingress objects declare only that environment's hostnames, so a request can never cross environments.
- Ingress annotations: `nginx.ingress.kubernetes.io/ssl-redirect: "false"`; API host adds `limit-rps: "20"`, `limit-burst-multiplier: "3"`, `proxy-body-size: "2m"`; objects host `proxy-body-size: "100m"`, `proxy-request-buffering: "off"`.
- Cloudflare WAF custom rules: rate limit `/v1/auth/login` (10/min/IP), `/webhooks/*` (120/min/IP); block non-`POST` on `/webhooks/*`.

---

## 6. Software Design

### 6.1 Repository Structure

```text
aegispulse/
├── PROJECT.md                         # single source of truth (this file)
├── CLAUDE.md · AGENTS.md · CHANGELOG.md · README.md
├── Makefile                           # unified task runner (all languages)
├── .gitlab-ci.yml                     # pipeline definition (logic lives in ci/*.sh)
├── .gitleaks.toml · .trivyignore · sonar-project.properties · .editorconfig
├── .claude/                           # AI guardrails: skills, agents, hooks, settings
├── ci/                                # build.sh, test-*.sh, scan-*.sh, sign.sh, deploy.sh, rollback.sh,
│                                      # check-boundaries.sh, check-layer-sizes.sh, check-resource-budget.sh
├── docs/
│   ├── AEGIS_PULSE.md · K3S_CONTEXT.md · PROJECT_TEMPLATE_GUIDE.md · libs/RXJS_RABBITMQ.md
│   ├── adr/                           # NNNN-title.md architecture decision records
│   ├── steering/                      # product.md, tech.md, structure.md, quality.md
│   ├── specs/                         # FR-level implementation specs (one per FR or FR group)
│   ├── runbooks/                      # dlq.md, replay.md, restore.md, key-rotation.md, incident.md
│   ├── threat-model/                  # STRIDE model + data-flow diagrams
│   └── evidence/                      # phase-exit evidence packs (commands, outputs, SHAs, dates)
├── packages/
│   ├── contracts/                     # SOURCE OF TRUTH for wire contracts
│   │   ├── envelope/                  # canonical-envelope.v1.schema.json (+ examples)
│   │   ├── events/                    # per-eventType payload JSON Schemas
│   │   ├── asyncapi/aegispulse.asyncapi.yaml
│   │   ├── openapi/                   # gateway.public.yaml + {service}.internal.yaml
│   │   ├── topology/aegispulse.topology.json   # exchanges, queues, bindings, retry tiers
│   │   ├── reference/fx-static-v1.json         # static FX table (§1.4.4): accepted currencies, USD per unit
│   │   └── generated/                 # ts/, java/, python/ — generated, never hand-edited
│   ├── ts-platform/                   # Node shared kit (no business logic)
│   │   └── src/{config,logging,telemetry,errors,http-client,auth,amqp,outbox,health,idempotency}/
│   ├── java-platform/                 # Spring Boot starter: logging, OTel, JWT, outbox, consumer kit, health
│   └── py-platform/                   # Python kit: config, structlog, OTel, JWT, aio-pika consumer kit, health
├── gateway/
│   └── nest-http/                     # SINGLE external HTTP/SSE/webhook entrypoint (NestJS on Fastify adapter, ADR-0013)
│       ├── src/modules/{domain}/      # {domain}.module.ts + {domain}.controller.ts — transport adapters only
│       ├── src/clients/               # {service}.client.ts — @Injectable typed service clients (generated types + undici)
│       ├── src/common/guards/         # jwt-auth.guard.ts (JWKS via jose), roles.guard.ts (coarse pre-check only)
│       ├── src/common/pipes/          # zod-validation.pipe.ts (schemas generated from packages/contracts)
│       ├── src/common/interceptors/   # correlation-id, logging, timeout, error-envelope mapping (§8.2)
│       ├── src/common/mappers/        # {domain}.mapper.ts — transport ↔ contract shape mapping
│       ├── src/stream/                # stream.controller.ts (@Sse) + broker subscription → tenant-filtered projections
│       ├── src/app.module.ts · src/main.ts   # NestFactory + FastifyAdapter({ bodyLimit }), rawBody: true
│       └── tests/
├── services/
│   ├── ingestion/                     # Node — webhooks, connectors, transaction intake
│   │   ├── src/domain/                # signature, envelope builder, connector normalizers
│   │   ├── src/service/               # ingestion.service.ts, connectors.service.ts, transactions.service.ts
│   │   │   └── orchestrators/         # ingest-webhook.usecase.ts, run-connector.usecase.ts
│   │   ├── src/db/                    # repositories + queries (pg); src/db/migrations/V*.sql (Flyway)
│   │   ├── src/storage/               # object store + redis adapters (owned infra clients)
│   │   ├── src/adapters/http/         # internal route adapters (/internal/v1/*)
│   │   ├── src/adapters/amqp/         # outbox relay publisher
│   │   ├── src/contracts/             # re-exports of generated contract types
│   │   └── tests/{unit,integration}/
│   ├── files/                         # Node — file lifecycle, validation, presign, sweeps (same layout)
│   ├── events/                        # Node — archive, classification, replay, dead letters (Mongo)
│   │   └── src/db/mongo-migrations/   # index/collection migrations (migrate-mongo)
│   ├── orchestrator/                  # Node — saga use cases; NO datastore; typed clients only
│   │   └── src/service/orchestrators/ # score-transaction.saga.ts, classified-signal.saga.ts,
│   │                                  # case-correlation.saga.ts, extraction-review.saga.ts, notification-dispatch.ts
│   ├── registry/                      # Java/Spring Boot — tenants, users, auth, RBAC, entities, watchlists
│   │   └── src/main/java/io/aegispulse/registry/{domain,service,db,adapters/http,adapters/amqp,config}/
│   │       src/main/resources/db/migration/V*.sql
│   ├── cases/                         # Java/Spring Boot — evaluations, cases, policy, audit, correlation hooks
│   ├── risk-scoring/                  # Python/FastAPI — features + scoring
│   │   └── src/aegis_risk/{domain,service,storage,adapters/http}/
│   ├── sensitivity-scanner/           # Python/FastAPI — sensitivity & severity inference
│   │   └── src/aegis_scanner/{domain,service,models,adapters/http}/
│   ├── doc-extraction/                # Python — consumer + parsing/NER/clauses
│   │   └── src/aegis_extract/{domain,service,parsers,clients,adapters/amqp,adapters/http}/
│   └── data-intel/                    # Python — facts, rollups, drift, eval runs, parquet
│       └── src/aegis_intel/{domain,service,db,adapters/amqp,adapters/http}/ + db/migrations/V*.sql
├── workers/
│   └── scheduler-trigger/             # Node CLI for CronJobs: calls ONE internal action, exits (no DB)
├── apps/
│   └── console/                       # React + Vite analyst console
│       └── src/{routes,features/{cases,events,files,admin,intel,auth},api,components,stream}/
├── eval/
│   ├── golden/                        # synthetic labeled dataset (versioned)
│   ├── baseline.json                  # committed metric baseline for CI gate
│   └── runner/                        # evaluation harness (Python)
├── scripts/
│   ├── demo/                          # webhook-sign.ts, upload.ts, scenario.ts, chaos/*.sh
│   ├── dev/                           # seed.ts, reset.sh, gen-local-secrets.sh, pg-bootstrap.sh
│   └── infisical/                     # seed.py (MB-06): folders + generated secrets from deploy/infisical/secrets-catalog.yaml
├── deploy/
│   ├── compose/docker-compose.yml     # local stack
│   ├── k8s/base/                      # namespace, quotas, netpols, deployments, statefulsets, cronjobs, ingresses
│   ├── k8s/overlays/{dev,prod,k3d-local}/
│   └── observability/                 # OpenObserve dashboards + alert definitions as JSON
├── infra/
│   └── terraform/aws-reference/       # documentation-grade reference only; never applied by CI
└── tests/
    ├── e2e/                           # Vitest + fetch E2E against compose/dev/prod
    ├── contract/                      # Pact-style consumer contracts + schema conformance
    ├── load/                          # k6 scripts
    ├── security/                      # netpol, cross-tenant, adversarial webhooks
    └── chaos/                         # chaos scenario assertions
```

Layout rules: `gateway/` and `workers/` contain no datastore clients; `services/*/src/service` and `src/domain` contain no HTTP/AMQP framework types; transport-specific types stay in `src/adapters/**` and `gateway/`.

### 6.2 Service Layer Internal RPC Contract

Every internal operation is a named `ServiceAction`. Each action maps 1:1 to an internal REST operation (`operationId` = action name) in `packages/contracts/openapi/{service}.internal.yaml`; TypeScript, Java, and Python types are generated from those specs. Tenant-scoped actions accept the `X-Aegis-Tenant` header (UUID), which the gateway forwards unchanged. The owning service honors it only for a `PLATFORM_ADMIN` user token and records `actingAs`; for any other principal a present header returns `403 FORBIDDEN`, and the reserved `platform` tenant (FR-TEN-09) can never be the acting tenant (`404`). Every `ServiceAction` is **invoked by dispatch adapters** (gateway handlers, consumer adapters, scheduler-trigger) or by orchestrators through typed clients, and is **implemented by service-layer modules only**.

```typescript
// packages/contracts/src/service-actions.ts  (generated index + hand-written union)
type ServiceAction =
  // ── registry (Java) ───────────────────────────────────────────────
  | { service: 'registry'; action: 'createTenant';          payload: CreateTenantInput }
  | { service: 'registry'; action: 'updateTenantStatus';    payload: { tenantId: UUID; status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED'; reason: string } }
  | { service: 'registry'; action: 'getTenantSettings';     payload: { tenantId: UUID } }
  | { service: 'registry'; action: 'updateTenantSettings';  payload: UpdateTenantSettingsInput }
  | { service: 'registry'; action: 'login';                 payload: { tenantSlug: string; email: string; password: string } }
  | { service: 'registry'; action: 'refreshToken';          payload: { refreshToken: string } }
  | { service: 'registry'; action: 'logout';                payload: { refreshToken: string } }
  | { service: 'registry'; action: 'changePassword';        payload: { currentPassword: string; newPassword: string } }
  | { service: 'registry'; action: 'issueClientCredentialsToken'; payload: { clientId: string; clientSecret: string; audience: 'aegispulse' | 'aegispulse-internal' } }
  | { service: 'registry'; action: 'getCurrentPrincipal';   payload: Record<string, never> }
  | { service: 'registry'; action: 'createUser';            payload: CreateUserInput }
  | { service: 'registry'; action: 'listUsers';             payload: ListUsersQuery }
  | { service: 'registry'; action: 'updateUser';            payload: UpdateUserInput }
  | { service: 'registry'; action: 'createServiceAccount';  payload: CreateServiceAccountInput }
  | { service: 'registry'; action: 'rotateServiceAccountSecret'; payload: { serviceAccountId: UUID } }
  | { service: 'registry'; action: 'revokeServiceAccount';  payload: { serviceAccountId: UUID } }
  | { service: 'registry'; action: 'listServiceAccounts';   payload: ListServiceAccountsQuery }
  | { service: 'registry'; action: 'createEntity';          payload: CreateEntityInput }
  | { service: 'registry'; action: 'getEntity';             payload: { entityId: UUID } }
  | { service: 'registry'; action: 'listEntities';          payload: ListEntitiesQuery }
  | { service: 'registry'; action: 'updateEntity';          payload: UpdateEntityInput }
  | { service: 'registry'; action: 'archiveEntity';         payload: { entityId: UUID } }
  | { service: 'registry'; action: 'resolveEntities';       payload: { tenantId: UUID; mentions: string[]; tickers?: string[] } }
  | { service: 'registry'; action: 'createWatchlist';       payload: CreateWatchlistInput }
  | { service: 'registry'; action: 'listWatchlists';        payload: ListWatchlistsQuery }
  | { service: 'registry'; action: 'updateWatchlist';       payload: UpdateWatchlistInput }
  | { service: 'registry'; action: 'deleteWatchlist';       payload: { watchlistId: UUID } }
  | { service: 'registry'; action: 'addWatchlistEntry';     payload: { watchlistId: UUID; entityId: UUID; note?: string } }
  | { service: 'registry'; action: 'removeWatchlistEntry';  payload: { watchlistId: UUID; entityId: UUID } }
  | { service: 'registry'; action: 'checkWatchlists';       payload: { tenantId: UUID; entityIds?: UUID[]; counterpartyRefs?: CounterpartyRef[] } }
  // ── ingestion (Node) ──────────────────────────────────────────────
  | { service: 'ingestion'; action: 'ingestWebhookDelivery'; payload: { sourceKey: string; headers: WebhookHeaders; rawBodyBase64: string; receivedAt: ISODateTime; clientIp: string } }
  | { service: 'ingestion'; action: 'createWebhookSource';   payload: CreateWebhookSourceInput }
  | { service: 'ingestion'; action: 'listWebhookSources';    payload: PageQuery }
  | { service: 'ingestion'; action: 'updateWebhookSource';   payload: UpdateWebhookSourceInput }
  | { service: 'ingestion'; action: 'rotateWebhookSecret';   payload: { sourceId: UUID } }
  | { service: 'ingestion'; action: 'deleteWebhookSource';   payload: { sourceId: UUID } }
  | { service: 'ingestion'; action: 'listWebhookDeliveries'; payload: ListDeliveriesQuery }
  | { service: 'ingestion'; action: 'expirePreviousSecrets'; payload: Record<string, never> }
  | { service: 'ingestion'; action: 'createConnector';       payload: CreateConnectorInput }
  | { service: 'ingestion'; action: 'listConnectors';        payload: PageQuery }
  | { service: 'ingestion'; action: 'updateConnector';       payload: UpdateConnectorInput }
  | { service: 'ingestion'; action: 'deleteConnector';       payload: { connectorId: UUID } }
  | { service: 'ingestion'; action: 'runConnectorNow';       payload: { connectorId: UUID } }
  | { service: 'ingestion'; action: 'runDueConnectors';      payload: Record<string, never> }
  | { service: 'ingestion'; action: 'submitTransaction';     payload: SubmitTransactionInput }
  | { service: 'ingestion'; action: 'submitTransactionBatch'; payload: { fileId: UUID; rows: SubmitTransactionInput[]; startRow: number } }
  | { service: 'ingestion'; action: 'getTransaction';        payload: { transactionId: UUID } }
  // ── files (Node) ──────────────────────────────────────────────────
  | { service: 'files'; action: 'initUpload';                payload: InitUploadInput }
  | { service: 'files'; action: 'completeUpload';            payload: { fileId: UUID; parts?: UploadPart[] } }
  | { service: 'files'; action: 'abortUpload';               payload: { fileId: UUID } }
  | { service: 'files'; action: 'getFile';                   payload: { fileId: UUID } }
  | { service: 'files'; action: 'listFiles';                 payload: ListFilesQuery }
  | { service: 'files'; action: 'getDownloadUrl';            payload: { fileId: UUID; acknowledgeQuarantine?: boolean } }
  | { service: 'files'; action: 'getInternalDownloadUrl';    payload: { fileId: UUID } }
  | { service: 'files'; action: 'deleteFile';                payload: { fileId: UUID } }
  | { service: 'files'; action: 'validateFile';              payload: { fileId: UUID; eventId: UUID } }          // consumer-invoked
  | { service: 'files'; action: 'markProcessing';            payload: { fileId: UUID; extractorVersion: string } }
  | { service: 'files'; action: 'recordExtractionResult';    payload: RecordExtractionResultInput }
  | { service: 'files'; action: 'recordProcessingFailure';   payload: { fileId: UUID; reason: string; retryable: boolean } }
  | { service: 'files'; action: 'registerRemoteFile';        payload: RegisterRemoteFileInput }
  | { service: 'files'; action: 'sweepOrphans';              payload: Record<string, never> }
  | { service: 'files'; action: 'purgeRetention';            payload: Record<string, never> }
  // ── events (Node) ─────────────────────────────────────────────────
  | { service: 'events'; action: 'archiveEvent';             payload: { envelope: CanonicalEnvelope; delivery: DeliveryMeta } }  // consumer-invoked
  | { service: 'events'; action: 'runAiScan';                payload: { tenantId: UUID; eventId: UUID; revision: number } }      // consumer-invoked
  | { service: 'events'; action: 'searchEvents';             payload: SearchEventsQuery }
  | { service: 'events'; action: 'getEvent';                 payload: { eventId: UUID; tier?: 'standard' | 'restricted' } }
  | { service: 'events'; action: 'getCorrelationChain';      payload: { correlationId: string } }
  | { service: 'events'; action: 'searchEventsForEntities';  payload: { tenantId: UUID; entityIds: UUID[]; eventTypes: string[]; since: ISODateTime; limit: number } }
  | { service: 'events'; action: 'overrideClassification';   payload: OverrideClassificationInput }
  | { service: 'events'; action: 'createReplayJob';          payload: CreateReplayJobInput }
  | { service: 'events'; action: 'getReplayJob';             payload: { jobId: UUID } }
  | { service: 'events'; action: 'cancelReplayJob';          payload: { jobId: UUID } }
  | { service: 'events'; action: 'recordDeadLetter';         payload: DeadLetterInput }                                         // consumer-invoked
  | { service: 'events'; action: 'listDeadLetters';          payload: ListDeadLettersQuery }
  | { service: 'events'; action: 'getDeadLetter';            payload: { deadLetterId: string } }
  | { service: 'events'; action: 'replayDeadLetter';         payload: { deadLetterId: string } }
  | { service: 'events'; action: 'discardDeadLetter';        payload: { deadLetterId: string; reason: string } }
  | { service: 'events'; action: 'sweepPendingScans';        payload: Record<string, never> }
  | { service: 'events'; action: 'purgeRetention';           payload: Record<string, never> }
  // ── cases (Java) ──────────────────────────────────────────────────
  | { service: 'cases'; action: 'recordRiskEvaluation';      payload: RecordRiskEvaluationInput }
  | { service: 'cases'; action: 'openCase';                  payload: OpenCaseInput }
  | { service: 'cases'; action: 'getCase';                   payload: { caseId: UUID } }
  | { service: 'cases'; action: 'getTransactionEvaluation';  payload: { transactionId: UUID } }   // FR-TXN-06 composition
  | { service: 'cases'; action: 'listCases';                 payload: ListCasesQuery }
  | { service: 'cases'; action: 'getCaseTimeline';           payload: { caseId: UUID } }
  | { service: 'cases'; action: 'assignCase';                payload: { caseId: UUID; assigneeUserId: UUID | null; expectedVersion: number } }
  | { service: 'cases'; action: 'addCaseNote';               payload: { caseId: UUID; body: string } }
  | { service: 'cases'; action: 'recordDisposition';         payload: RecordDispositionInput }
  | { service: 'cases'; action: 'requestReevaluation';       payload: { caseId: UUID; reason: string } }
  | { service: 'cases'; action: 'reevaluateOpenCases';       payload: { tenantId: UUID; entityIds: UUID[]; triggerEventId: UUID } }
  | { service: 'cases'; action: 'attachEvidence';            payload: { caseId: UUID; items: EvidenceItem[] } }
  | { service: 'cases'; action: 'runEnrichmentTimeouts';     payload: Record<string, never> }
  | { service: 'cases'; action: 'autoResolveCleared';        payload: Record<string, never> }
  | { service: 'cases'; action: 'ingestAuditEvent';          payload: { envelope: CanonicalEnvelope } }                        // consumer-invoked
  | { service: 'cases'; action: 'listAuditEntries';          payload: ListAuditQuery }
  | { service: 'cases'; action: 'verifyAuditChain';          payload: { tenantId?: UUID; fromSeq?: number; toSeq?: number } }
  // ── orchestrator (Node; consumer-invoked only) ────────────────────
  | { service: 'orchestrator'; action: 'scoreTransactionSaga';   payload: { envelope: CanonicalEnvelope<TxnSubmittedPayload> } }
  | { service: 'orchestrator'; action: 'classifiedSignalSaga';   payload: { envelope: CanonicalEnvelope<ClassificationFinalizedPayload> } }
  | { service: 'orchestrator'; action: 'caseCorrelationSaga';    payload: { envelope: CanonicalEnvelope<CorrelationRequestedPayload> } }
  | { service: 'orchestrator'; action: 'extractionReviewSaga';   payload: { envelope: CanonicalEnvelope<ExtractionReviewPayload> } }
  | { service: 'orchestrator'; action: 'dispatchNotification';   payload: { envelope: CanonicalEnvelope<NotificationRequestedPayload> } }
  // ── risk-scoring / scanner (Python) ───────────────────────────────
  | { service: 'riskScoring'; action: 'score';               payload: ScoreRequest }
  | { service: 'scanner';     action: 'scan';                payload: ScanRequest }
  // ── doc-extraction (Python; consumer-invoked) ─────────────────────
  | { service: 'docExtraction'; action: 'processFile';       payload: { envelope: CanonicalEnvelope<DocFileReadyPayload> } }
  // ── data-intel (Python) ───────────────────────────────────────────
  | { service: 'dataIntel'; action: 'recordFact';            payload: { envelope: CanonicalEnvelope } }                        // consumer-invoked
  | { service: 'dataIntel'; action: 'runRollups';            payload: { scope: 'today' | 'yesterday' } }
  | { service: 'dataIntel'; action: 'runDriftChecks';        payload: Record<string, never> }
  | { service: 'dataIntel'; action: 'exportParquet';         payload: { date: ISODate } }
  | { service: 'dataIntel'; action: 'recordEvalRun';         payload: EvalRunInput }
  | { service: 'dataIntel'; action: 'getIntelSummary';       payload: IntelQuery }
  | { service: 'dataIntel'; action: 'getDrift';              payload: IntelQuery }
  | { service: 'dataIntel'; action: 'getDisagreement';       payload: IntelQuery }
  | { service: 'dataIntel'; action: 'getLatency';            payload: IntelQuery }
  | { service: 'dataIntel'; action: 'getPrecision';          payload: IntelQuery }
  | { service: 'dataIntel'; action: 'listEvalRuns';          payload: PageQuery };
```

Internal route convention (uniform RPC, decided in Phase 1a): **every** HTTP-invoked action is `POST /internal/v1/{action}` with the payload as the JSON body, commands and queries alike, so one typed client (`invoke(action, payload)`) covers every service. Consumer-invoked actions are not HTTP routes; each internal spec lists them under `x-aegis-consumer-actions`. `make contracts` fails if this union and the internal OpenAPI specs diverge. All internal routes require a JWT (user token forwarded by the gateway, or a `SERVICE` token whose `act[]` includes the action).

### 6.3 Tech Stack

> Versions are baseline majors; Phase 0 pins exact versions after verifying current stable releases and records them in `docs/steering/tech.md`.

| Layer | Technology |
|---|---|
| Edge gateway | Node.js 24 LTS, TypeScript 6.0 strict (+ `experimentalDecorators`/`emitDecoratorMetadata`, gateway only; TS 7 deferred, see `docs/steering/tech.md`), **NestJS 12 on `@nestjs/platform-fastify` (Fastify 5)** (ADR-0013), `@nestjs/throttler` (in-memory, per-pod defense only), `jose` (JWKS) in a Nest guard, Zod validation pipe (schemas from contracts), `@Sse` + RxJS for streaming, `undici` typed clients. Public OpenAPI is served from `packages/contracts` (no `@nestjs/swagger` generation) |
| Node services | Node.js 24, TypeScript, Fastify 5 (internal adapters), `pg` + Kysely (typed SQL), `mongodb` driver 6, `ioredis`, `@aws-sdk/client-s3` + `s3-request-presigner`, `opossum` (circuit breaker), `undici` (HTTP client), `pino` |
| Node messaging | `rxjs-rabbitmq` (author's library, [docs/libs/RXJS_RABBITMQ.md](docs/libs/RXJS_RABBITMQ.md)) on `amqplib`, wrapped by `packages/ts-platform/amqp` with typed generics from the topology contract, publisher confirms, retry/DLQ policy |
| Java services | Java 25 LTS, Spring Boot 4.2, Spring Web MVC (virtual threads), Spring Security OAuth2 Resource Server + Nimbus JOSE (registry issuer), Spring JDBC `JdbcClient`, Spring AMQP, Resilience4j, Bean Validation, Flyway, Micrometer + OTel Java agent, ArchUnit, password4j (Argon2id) |
| Python services | Python 3.13, uv, FastAPI, Pydantic v2, `aio-pika`, SQLAlchemy 2 Core + psycopg 3 (data-intel), `redis-py` (risk-scoring), boto3 (S3 API), spaCy 3 (`en_core_web_sm`), scikit-learn, pdfplumber, pytesseract + Tesseract 5, selectolax, polars + pyarrow, structlog, `pybreaker`, OpenTelemetry SDK |
| Optional LLM adjudicator | Anthropic Claude API (`claude-haiku-5-5`), off by default, budget-capped, redacted text only, behind `LlmAdjudicator` port with deterministic stub |
| Datastores | PostgreSQL 18, MongoDB 8.0, Redis 8, SeaweedFS 4.54 S3-compatible object store (ADR-0011) |
| Messaging | RabbitMQ 4.x (quorum queues, Prometheus plugin) |
| Migrations | Flyway (SQL, all PostgreSQL schemas, run as Jobs), `migrate-mongo` (Mongo indexes/collections) |
| Contracts | OpenAPI 3.1, AsyncAPI 3.0, JSON Schema 2020-12; generators: `openapi-typescript`, `datamodel-code-generator` (Pydantic), and Java records for the envelope, event payloads and topology constants emitted by `packages/contracts/scripts/java-records.ts` (dependency-free records + JSpecify, Phase 1c); OpenAPI Generator (Java) is reserved for internal request/response DTOs of the Java services when Phase 2 needs them |
| Frontend | React 19, Vite, TypeScript, TanStack Router + TanStack Query, Zustand (session), Tailwind CSS + Radix UI primitives, Recharts, `@microsoft/fetch-event-source`, served by `nginx-unprivileged` |
| Testing | Vitest, Testcontainers (Node/Java/Python), JUnit Jupiter + AssertJ, pytest + hypothesis, Playwright + axe-core, k6, Schemathesis (OpenAPI fuzz) |
| Local emulation | Docker Compose (§10.3), optional k3d |
| Container builds | multi-stage Dockerfiles; distroless/`-slim` bases; kaniko in CI (cluster standard; upstream kaniko is archived — evaluate the maintained fork or buildah in Phase 10) |
| IaC | Kustomize (plain manifests + overlays, ADR-0006), Terraform for Cloudflare DNS/tunnel routes (optional) and AWS reference docs |
| CI/CD | self-hosted GitLab CE pipelines, kubernetes executor runners |
| Security tooling | Gitleaks (pre-commit + CI), GitLab SAST/Secret Detection/Dependency Scanning, SonarQube Community Build, Trivy (image + config + fs), Syft SBOM, cosign, OWASP ZAP (baseline + API scan), Trivy Operator (runtime) |
| Secrets | Infisical (self-hosted) + Infisical Kubernetes Operator; GitLab CI variables for pipeline-only secrets |
| Observability | OpenTelemetry (traces/metrics/logs) → OpenObserve; RabbitMQ Prometheus metrics; Uptime Kuma + ntfy |

### 6.4 Canonical Event Envelope (schemaVersion 1.1.0)

```json
{
  "eventId": "019352b8-7c4a-7e10-9a21-4f8c2d1e9b01",
  "correlationId": "corr-98f1a2b3-4c5d-6e7f-8a9b-0c1d2e3f4a5b",
  "causationId": "019352b8-7110-7b22-8c33-1a2b3c4d5e6f",
  "tenantId": "8f2a6a5e-3d1b-4c7e-9a0f-1b2c3d4e5f60",
  "tenantSlug": "tenant-acme-capital",
  "schemaVersion": "1.1.0",
  "eventType": "external.regulatory.published",
  "source": "webhook:sec-edgar-relay",
  "producer": "aegispulse-ingestion@3f9c2ab",
  "occurredAt": "2026-11-21T21:30:00Z",
  "ingestedAt": "2026-11-21T21:30:01.142Z",
  "idempotencyKey": "sec-edgar-relay:rel-2026-8841:v1",
  "classification": {
    "sensitivity": "CONFIDENTIAL",
    "categories": ["REGULATORY", "FINANCIAL"],
    "publisher_stated_severity": "MEDIUM",
    "source_trust_level": "TRUSTED",
    "algorithm_severity": "HIGH",
    "algorithm_confidence": 0.82,
    "final_severity": "HIGH",
    "classification_source": "AI_SCANNER",
    "rule_version": "rules-v1.0.0",
    "classifier_version": "sensitivity-clf-v1.2.0",
    "status": "CLASSIFIED"
  },
  "payload": {
    "externalId": "rel-2026-8841",
    "category": "REGULATION_PUBLISHED",
    "title": "Updated Cross-Border Liquidity Reporting Requirements",
    "fileId": "1c9e0f4a-7a33-4b44-9c6d-7e8f9a0b1c2d",
    "storageKey": "raw/8f2a6a5e-…/2026/11/21/1c9e0f4a-…",
    "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "mentionedEntities": ["ACME Holdings", "Globex Clearing"]
  }
}
```

Rules:
- `eventId`: UUIDv7 (time-ordered) generated by the producer; deterministic UUIDv5 (namespace `aegispulse`) when the producer lacks a transactional store (FR-DOC, scanner-driven events). `tenantId` is the tenant UUID; `tenantSlug` is informational.
- `correlationId`: `corr-` + UUID, created at the first ingress point (webhook, API call, connector item) and propagated unchanged; `causationId` = `eventId` of the message that directly caused this one (null for roots).
- `classification` is **required** on every published envelope. Producers set what they know (at minimum `sensitivity` — `UNCLASSIFIED` if unknown — and `status = INGESTED`); the Events Service is the authority for the archived classification. The block on the wire is a snapshot; consumers needing the authoritative value use `classification.finalized`.
- `payload` ≤ 64 KiB serialized; whole message ≤ 256 KiB; binary data forbidden (pointers only: `fileId`, `storageKey`, `sha256`).
- AMQP properties: `messageId = eventId`, `correlationId`, `type = eventType`, `contentType = application/json`, `deliveryMode = 2`, `timestamp`. Headers: `traceparent`, `tracestate`, `x-aegis-tenant`, `x-aegis-schema-version`, `x-retry-count`, `x-aegis-replay-job`, `x-aegis-replay-generation`, `x-aegis-error-code` (DLQ only), `x-aegis-original-queue` (DLQ only), `x-aegis-error-message` (DLQ only; the log-safe error description, ≤ 500 chars, no payload content: the full text only for the platform's own error types, otherwise the type name with "(message withheld)"), `x-aegis-error-stack-hash` (DLQ only; first 16 hex of SHA-256 over the error name + stack frames without line numbers, grouping identical failures; FR-MSG-02).

### 6.5 Messaging Topology & Consumer Kit

- Exchanges (topic, durable): `aegispulse.ingress`, `aegispulse.enrichment`, `aegispulse.domain`, `aegispulse.intelligence`; direct: `aegispulse.retry`; **topic**: `aegispulse.dlx` (routing key = original queue name; topic so `events.deadletter.q` can bind `#` while each `{queue}.dlq` binds its exact queue name). Topology lives in `packages/contracts/topology/aegispulse.topology.json` and is asserted by a migration-style Job (`aegispulse-topology`) using the `aegis_topology` RabbitMQ user; runtime users cannot declare/delete resources.
- Consumer kit responsibilities (TS `packages/ts-platform/amqp`, Java `java-platform`, Python `py-platform`): deserialize + validate envelope; establish log/trace context; dedupe via `processed_messages` when the consumer's service owns a store; call one service action; ack on success; classify failure (`TransientError`, `PermanentError`, `PoisonMessageError`); retry by republishing to `aegispulse.retry` with routing key `{queue}.retry.{tier}` and `x-retry-count+1`; dead-letter by publishing to `aegispulse.dlx` routing `{queue}` with error headers; always ack the original after a successful republish (publisher confirm), otherwise nack-requeue. The TS kit also offers raw consumption without envelope validation (`consumeRaw`), used only by the dead-letter registry on `events.deadletter.q`: failures retry in process with capped backoff, then requeue, never dead-letter again (§5.5). Java and Python kits need no equivalent (no registry consumer there).
- Circuit breakers: HTTP clients per dependency — open at ≥ 50% failures over a 20-call rolling window, half-open after 30 s, timeout per §2 (scoring 2 s, scanner 10 s, registry 1 s, cases 3 s, events search 3 s). Breaker-open errors are `TransientError`.

### 6.6 Transactional Outbox

```
outbox_events(id, tenant_id, event_id UNIQUE, exchange, routing_key, envelope JSONB,
              status PENDING|SENT|FAILED, attempts, available_at, created_at, sent_at, last_error)
```
- Services insert outbox rows in the same transaction as the state change. An in-process relay polls every 250 ms (`SELECT … FOR UPDATE SKIP LOCKED LIMIT 100 WHERE status='PENDING' AND available_at <= now()`), publishes with confirms, marks `SENT`. Failures back off (`available_at = now() + 2^attempts s`, cap 5 min); after 20 attempts `FAILED` + alert.
- `aegispulse_outbox_lag_seconds` = age of oldest `PENDING` row; alert at > 60 s for 5 min.
- `SENT` rows are purged after 7 days. Events Service uses an equivalent Mongo `outbox` collection inside multi-document transactions.

### 6.7 Event Catalog

| Routing key (= `eventType`) | Exchange | Producer | Key payload fields |
|---|---|---|---|
| `external.regulatory.published` · `external.ipo.filed` · `external.acquisition.announced` · `external.market.alert` · `external.compliance.disclosed` | ingress | ingestion | `externalId, category, title, summary, publishedAt, url, mentionedEntities, tickers, rawStorageKey, deliveryId|connectorId` |
| `txn.submitted` | ingress | ingestion | `transactionId, accountId, counterpartyId, counterpartyName, amount, currency, country, channel, occurredAt` |
| `file.uploaded` | ingress | files | `fileId, storageKey, sha256, sizeBytes, contentType, purpose, sourceType` |
| `file.status.changed` | enrichment | files | `fileId, from, to, reason` |
| `doc.file.ready` | enrichment | files | `fileId, storageKey, sha256, contentType, purpose` |
| `doc.extraction.completed` · `doc.extraction.review_required` | enrichment | files (on behalf of doc-extraction) | `fileId, extractorVersion, eventTypeGuess, mentionedEntities, redFlags, confidence, textExcerpt, artifactKeys` |
| `classification.scan.requested` | enrichment | events | `eventId, revision` |
| `classification.finalized` | enrichment | events | `eventId, eventType, sensitivity, categories, publisher/algorithm/final severity, source, mentionedEntities, revision` |
| `classification.overridden` | enrichment | events | `eventId, before, after, actorId, justification` |
| `risk.evaluation.recorded` | domain | cases | `evaluationId, transactionEventId, score, band, factors, modelVersion, caseId?` |
| `case.opened` · `case.transitioned` · `case.escalated` · `case.resolved` · `case.disposition.recorded` · `case.evidence.attached` | domain | cases | `caseId, caseNumber, type, from, to, severity, policyScore, policyVersion, entityIds, disposition?` |
| `correlation.requested` | domain | cases | `caseId, entityIds, lookbackDays` |
| `registry.tenant.created|suspended|restored|deactivated|settings_changed` · `registry.user.changed` · `registry.service_account.changed` · `registry.auth.refresh_reuse_detected` · `registry.entity.changed` · `registry.watchlist.changed` | domain | registry | ids + changed fields (no secrets/password data) |
| `notification.requested` | domain/enrichment/intelligence | cases, events, files, ingestion, data-intel | `templateId, severity, notificationKey, vars` |
| `intel.rollup.completed` · `intel.drift.detected` · `intel.eval.completed` | intelligence | data-intel | `metric, scope, value, threshold, window` |
| `ops.dead_letter.recorded` · `ops.replay.started|completed` · `ops.audit.quarantine_download` · `ops.audit.file_deleted` · `ops.audit.dead_letter_resolved` · `ops.audit.source_trust_changed` | intelligence | events / files / ingestion | operational ids + actor |

### 6.8 Error Model

- Domain errors are typed: TS `Result<T, DomainError>` (`neverthrow`-style, hand-rolled in `ts-platform/errors`), Java sealed `DomainException` hierarchy, Python `DomainError` subclasses. Each carries a stable `code` from §8.4.
- Adapters map codes to HTTP status (§8.4) or consumer outcomes (`TransientError`/`PermanentError`). Unhandled exceptions → `500 INTERNAL_ERROR` with `traceId`, never stack traces to clients.
- Node: `process.on('unhandledRejection')` logs fatal and exits non-zero (Kubernetes restarts); lint rule `@typescript-eslint/no-floating-promises: error`.

### 6.9 Configuration
- 12-factor: env vars only, parsed at startup by a typed schema (Zod / `@ConfigurationProperties` + validation / Pydantic Settings). Unknown or missing required values abort startup with a single structured error listing every problem (secret values redacted).
- Feature flags (env): `SCANNER_LLM_ENABLED`, `FILES_AV_ENABLED`, `RISK_MODEL=heuristic|iforest`, `DEMO_MODE_ALLOWED`, `MULTIPART_UPLOADS_ENABLED`.


---

## 7. Data Model

Conventions: PostgreSQL 18, one schema per owning service, Flyway files at `services/{svc}/db/migrations/V{n}__{desc}.sql` (Java: `src/main/resources/db/migration/`). Primary keys `UUID DEFAULT gen_random_uuid()` unless an externally generated UUIDv7 is supplied by the service (event ids). Every table has `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`; mutable tables have `updated_at` maintained by the shared `set_updated_at()` trigger. All money is `NUMERIC(22,4)`. All tenant tables carry `tenant_id UUID NOT NULL` and an RLS policy.

### 7.0 Shared Per-Schema Objects

Created by each service's `V1__baseline.sql` in its own schema (shown for `ingestion`; identical shape in `files`, `registry`, `cases`, `analytics`).

#### {schema}.outbox_events
```sql
CREATE TABLE ingestion.outbox_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID,                                  -- null only for platform-level events
  event_id      UUID NOT NULL,                         -- envelope eventId (UUIDv7)
  exchange      TEXT NOT NULL,
  routing_key   TEXT NOT NULL,
  envelope      JSONB NOT NULL,                        -- full canonical envelope
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED')),
  attempts      INT  NOT NULL DEFAULT 0,
  available_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),    -- backoff scheduling
  last_error    TEXT,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_outbox_event_id ON ingestion.outbox_events (event_id);
CREATE INDEX ix_outbox_pending ON ingestion.outbox_events (available_at) WHERE status = 'PENDING';
CREATE INDEX ix_outbox_sent_purge ON ingestion.outbox_events (sent_at) WHERE status = 'SENT';
```

#### {schema}.processed_messages
```sql
CREATE TABLE files.processed_messages (            -- consumer dedup (schemas with consumers)
  consumer           TEXT NOT NULL,                -- e.g. 'files.validation.q'
  event_id           UUID NOT NULL,
  replay_generation  INT  NOT NULL DEFAULT 0,      -- 0 = original delivery
  processed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (consumer, event_id, replay_generation)
);
CREATE INDEX ix_processed_messages_purge ON files.processed_messages (processed_at);  -- 14-day purge
```

#### {schema}.idempotency_records
```sql
CREATE TABLE ingestion.idempotency_records (       -- HTTP Idempotency-Key store (24 h)
  tenant_id        UUID NOT NULL,
  scope            TEXT NOT NULL,                  -- action name, e.g. 'submitTransaction'
  idempotency_key  TEXT NOT NULL,
  request_sha256   TEXT NOT NULL,
  response_status  INT,
  response_body    JSONB,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, scope, idempotency_key)
);
CREATE INDEX ix_idem_expires ON ingestion.idempotency_records (expires_at);
```

#### RLS pattern (applied to every tenant table)
```sql
ALTER TABLE ingestion.webhook_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.webhook_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ingestion.webhook_sources
  USING (tenant_id = ingestion.current_tenant())
  WITH CHECK (tenant_id = ingestion.current_tenant());
-- current_tenant() is created per schema by V1__baseline.sql; with no tenant context RLS fails closed (0 rows).
-- There is no bypass clause (ADR-0016): cross-tenant work goes through SECURITY DEFINER functions, e.g.
CREATE FUNCTION ingestion.purge_expired_idempotency_records() RETURNS integer
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ … $$;
ALTER FUNCTION ingestion.purge_expired_idempotency_records() OWNER TO ingestion_platform;  -- NOLOGIN BYPASSRLS
REVOKE ALL ON FUNCTION ingestion.purge_expired_idempotency_records() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingestion.purge_expired_idempotency_records() TO svc_ingestion;
```
`outbox_events` and `processed_messages` carry no RLS (never read on behalf of a tenant request). A Flyway `afterMigrate.sql` callback per schema keeps `flyway_schema_history` read-only (SELECT) for `svc_*`, so services can check the schema version for readiness but cannot alter it.
Services run `SET LOCAL app.tenant_id = $1` at the start of every transaction. No session setting can lift RLS: cross-tenant platform operations (retention purges, scheduled sweeps, tenant-resolving lookups such as webhook source by key) are `SECURITY DEFINER` functions owned by `{schema}_platform` (NOLOGIN, BYPASSRLS), defined in reviewed migrations with a fixed `search_path`, with `EXECUTE` granted to `svc_{schema}` only. Each FR that needs one adds it in its own migration with a migration test (ADR-0016).

### 7.1 Schema `registry` (Owner: registry)

#### registry.tenants
```sql
CREATE TABLE registry.tenants (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                      TEXT NOT NULL CHECK (slug ~ '^[a-z0-9-]{3,40}$'),
  display_name              TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  status                    TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DEACTIVATED')),
  status_reason             TEXT,
  high_value_threshold_usd  NUMERIC(22,4) NOT NULL DEFAULT 50000,
  high_risk_countries       TEXT[] NOT NULL DEFAULT '{}',          -- ISO-3166 alpha-2
  retention_days            INT NOT NULL DEFAULT 400 CHECK (retention_days BETWEEN 30 AND 3650),
  demo_mode                 BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_tenants_slug ON registry.tenants (slug);
CREATE INDEX ix_tenants_status ON registry.tenants (status);
```

#### registry.users
```sql
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
```

#### registry.user_roles
```sql
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
```

#### registry.refresh_tokens
```sql
CREATE TABLE registry.refresh_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES registry.tenants(id),
  user_id       UUID NOT NULL REFERENCES registry.users(id),
  family_id     UUID NOT NULL,                      -- rotation family; reuse revokes family
  token_sha256  TEXT NOT NULL,                      -- never store raw token
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ROTATED','REVOKED')),
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_refresh_token_hash ON registry.refresh_tokens (token_sha256);
CREATE INDEX ix_refresh_family ON registry.refresh_tokens (family_id);
CREATE INDEX ix_refresh_user ON registry.refresh_tokens (user_id, status);
```

#### registry.service_accounts
```sql
CREATE TABLE registry.service_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID REFERENCES registry.tenants(id),   -- null for internal SERVICE accounts
  client_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('INTEGRATION','SERVICE')),
  allowed_actions TEXT[] NOT NULL DEFAULT '{}',          -- act[] claim for SERVICE accounts (§5.7.4)
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_by    UUID REFERENCES registry.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_service_accounts_tenant CHECK ((kind = 'SERVICE') = (tenant_id IS NULL))
);
CREATE UNIQUE INDEX ux_service_accounts_client_id ON registry.service_accounts (client_id);
CREATE INDEX ix_service_accounts_tenant ON registry.service_accounts (tenant_id);
CREATE INDEX ix_service_accounts_tenant_created ON registry.service_accounts (tenant_id, created_at, id);  -- keyset list
```

#### registry.service_account_secrets
```sql
CREATE TABLE registry.service_account_secrets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_account_id  UUID NOT NULL REFERENCES registry.service_accounts(id),
  secret_hash         TEXT NOT NULL,                -- Argon2id
  valid_until         TIMESTAMPTZ,                  -- set to now()+24h on rotation for the previous secret
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_sa_secrets_account ON registry.service_account_secrets (service_account_id);
```

#### registry.signing_keys
```sql
CREATE TABLE registry.signing_keys (               -- public halves only; private keys live in Infisical
  kid            TEXT PRIMARY KEY,
  public_jwk     JSONB NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('CURRENT','PREVIOUS','RETIRED')),
  activated_at   TIMESTAMPTZ NOT NULL,
  retired_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_signing_keys_status ON registry.signing_keys (status);
CREATE UNIQUE INDEX ux_signing_keys_one_current ON registry.signing_keys ((status)) WHERE status = 'CURRENT';
```

#### registry.entities
```sql
CREATE TABLE registry.entities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES registry.tenants(id),
  name             TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  normalized_name  TEXT NOT NULL,                   -- lower, punctuation + legal suffix stripped
  entity_type      TEXT NOT NULL CHECK (entity_type IN ('ORGANIZATION','TICKER','COUNTERPARTY','AGENCY','PERSON')),
  ticker           TEXT CHECK (ticker ~ '^[A-Z.]{1,10}$'),
  lei              TEXT CHECK (lei ~ '^[A-Z0-9]{20}$'),
  country          TEXT CHECK (country ~ '^[A-Z]{2}$'),
  archived_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_entities_tenant_norm ON registry.entities (tenant_id, normalized_name) WHERE archived_at IS NULL;
CREATE INDEX ix_entities_tenant_ticker ON registry.entities (tenant_id, ticker) WHERE ticker IS NOT NULL;
CREATE INDEX ix_entities_trgm ON registry.entities USING gin (normalized_name gin_trgm_ops);
```

#### registry.entity_aliases
```sql
CREATE TABLE registry.entity_aliases (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES registry.tenants(id),
  entity_id         UUID NOT NULL REFERENCES registry.entities(id),
  alias             TEXT NOT NULL,
  normalized_alias  TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_alias_tenant_norm ON registry.entity_aliases (tenant_id, normalized_alias);
CREATE INDEX ix_alias_entity ON registry.entity_aliases (entity_id);
CREATE INDEX ix_alias_trgm ON registry.entity_aliases USING gin (normalized_alias gin_trgm_ops);
```

#### registry.watchlists
```sql
CREATE TABLE registry.watchlists (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES registry.tenants(id),
  name            TEXT NOT NULL,
  reason          TEXT NOT NULL,
  severity_floor  TEXT NOT NULL DEFAULT 'HIGH' CHECK (severity_floor IN ('INFO','LOW','MEDIUM','HIGH','CRITICAL')),
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED')),
  deleted_at      TIMESTAMPTZ,
  created_by      UUID REFERENCES registry.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_watchlists_tenant_name ON registry.watchlists (tenant_id, lower(name)) WHERE deleted_at IS NULL;
```

#### registry.watchlist_entries
```sql
CREATE TABLE registry.watchlist_entries (
  watchlist_id  UUID NOT NULL REFERENCES registry.watchlists(id),
  entity_id     UUID NOT NULL REFERENCES registry.entities(id),
  tenant_id     UUID NOT NULL REFERENCES registry.tenants(id),
  note          TEXT,
  added_by      UUID REFERENCES registry.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (watchlist_id, entity_id)
);
CREATE INDEX ix_watchlist_entries_entity ON registry.watchlist_entries (tenant_id, entity_id);
```

### 7.2 Schema `ingestion` (Owner: ingestion)

#### ingestion.webhook_sources
```sql
CREATE TABLE ingestion.webhook_sources (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL,                -- registry tenant (no cross-schema FK by design)
  source_key                TEXT NOT NULL CHECK (source_key ~ '^[a-z0-9-]{3,60}$'),
  display_name              TEXT NOT NULL,
  trust_level               TEXT NOT NULL DEFAULT 'UNTRUSTED' CHECK (trust_level IN ('TRUSTED','UNTRUSTED')),
  payload_profile           TEXT NOT NULL DEFAULT 'AEGIS_MARKET_EVENT_V1',
  allowed_attachment_hosts  TEXT[] NOT NULL DEFAULT '{}',
  status                    TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  deleted_at                TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_webhook_sources_key ON ingestion.webhook_sources (source_key);
CREATE INDEX ix_webhook_sources_tenant ON ingestion.webhook_sources (tenant_id, status);
```

#### ingestion.webhook_secrets
```sql
CREATE TABLE ingestion.webhook_secrets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  source_id        UUID NOT NULL REFERENCES ingestion.webhook_sources(id),
  slot             TEXT NOT NULL CHECK (slot IN ('CURRENT','PREVIOUS')),
  ciphertext       BYTEA NOT NULL,                  -- AES-256-GCM(secret) with per-row data key
  wrapped_data_key BYTEA NOT NULL,                  -- data key wrapped by INGESTION_KEK
  nonce            BYTEA NOT NULL,
  kek_version      INT NOT NULL,
  expires_at       TIMESTAMPTZ,                     -- PREVIOUS slot: rotation time + 72 h
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_webhook_secret_slot ON ingestion.webhook_secrets (source_id, slot);
```

#### ingestion.webhook_deliveries
```sql
CREATE TABLE ingestion.webhook_deliveries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  source_id         UUID NOT NULL REFERENCES ingestion.webhook_sources(id),
  delivery_id       TEXT NOT NULL,                  -- X-Aegis-Delivery-Id
  idempotency_key   TEXT NOT NULL,                  -- {sourceKey}:{externalId}:v{n}
  event_id          UUID,                           -- null when duplicate
  outcome           TEXT NOT NULL CHECK (outcome IN ('ACCEPTED','DUPLICATE')),
  external_id       TEXT NOT NULL,
  category          TEXT NOT NULL,
  raw_storage_key   TEXT NOT NULL,
  raw_sha256        TEXT NOT NULL,
  signature_slot    TEXT NOT NULL CHECK (signature_slot IN ('CURRENT','PREVIOUS')),
  attachment_notes  JSONB NOT NULL DEFAULT '[]',     -- rejected/registered attachments
  received_at       TIMESTAMPTZ NOT NULL,
  correlation_id    TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_deliveries_source_delivery ON ingestion.webhook_deliveries (source_id, delivery_id);
CREATE UNIQUE INDEX ux_deliveries_accepted_idem ON ingestion.webhook_deliveries (tenant_id, idempotency_key) WHERE outcome = 'ACCEPTED';
CREATE INDEX ix_deliveries_tenant_received ON ingestion.webhook_deliveries (tenant_id, received_at DESC);
```
Rejected deliveries are **not** stored (metrics + logs only) to avoid unauthenticated write amplification.

#### ingestion.connectors
```sql
CREATE TABLE ingestion.connectors (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL,
  connector_key         TEXT NOT NULL CHECK (connector_key ~ '^[a-z0-9-]{3,60}$'),
  kind                  TEXT NOT NULL CHECK (kind IN ('RSS','ATOM','SEC_EDGAR_ATOM','JSON_FEED')),
  url                   TEXT NOT NULL CHECK (url LIKE 'https://%'),
  allowed_hosts         TEXT[] NOT NULL,
  interval_minutes      INT NOT NULL CHECK (interval_minutes BETWEEN 15 AND 1440),
  default_category      TEXT NOT NULL,
  trust_level           TEXT NOT NULL DEFAULT 'UNTRUSTED' CHECK (trust_level IN ('TRUSTED','UNTRUSTED')),
  mapping               JSONB,                         -- JSONPath map for JSON_FEED
  status                TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED','PAUSED_ERROR')),
  etag                  TEXT,
  last_modified         TEXT,
  last_item_published_at TIMESTAMPTZ,
  last_run_at           TIMESTAMPTZ,
  next_run_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consecutive_failures  INT NOT NULL DEFAULT 0,
  last_error            TEXT,
  deleted_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_connectors_tenant_key ON ingestion.connectors (tenant_id, connector_key) WHERE deleted_at IS NULL;
CREATE INDEX ix_connectors_due ON ingestion.connectors (next_run_at) WHERE status = 'ACTIVE' AND deleted_at IS NULL;
```

#### ingestion.connector_items
```sql
CREATE TABLE ingestion.connector_items (            -- durable dedup of feed items
  tenant_id       UUID NOT NULL,
  connector_id    UUID NOT NULL REFERENCES ingestion.connectors(id),
  idempotency_key TEXT NOT NULL,                    -- connector:{key}:{externalId}:v1
  event_id        UUID NOT NULL,
  external_id     TEXT NOT NULL,
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, idempotency_key)
);
CREATE INDEX ix_connector_items_connector ON ingestion.connector_items (connector_id, created_at DESC);
```

#### ingestion.transaction_submissions
```sql
CREATE TABLE ingestion.transaction_submissions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  idempotency_key   TEXT NOT NULL,
  request_sha256    TEXT NOT NULL,                  -- detects key reuse with different body
  event_id          UUID NOT NULL,
  correlation_id    TEXT NOT NULL,
  account_id        TEXT NOT NULL,
  counterparty_id   TEXT NOT NULL,
  counterparty_name TEXT NOT NULL,
  amount            NUMERIC(22,4) NOT NULL CHECK (amount > 0),
  currency          CHAR(3) NOT NULL,
  country           CHAR(2) NOT NULL,
  channel           TEXT NOT NULL CHECK (channel IN ('WIRE','ACH','CARD','CRYPTO','INTERNAL')),
  occurred_at       TIMESTAMPTZ NOT NULL,
  metadata          JSONB NOT NULL DEFAULT '{}',
  source_file_id    UUID,                            -- batch rows
  source_row        INT,
  submitted_by      TEXT NOT NULL,                   -- actor reference: user:{uuid} | integration:{clientId}
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_txn_tenant_idem ON ingestion.transaction_submissions (tenant_id, idempotency_key);
CREATE UNIQUE INDEX ux_txn_event_id ON ingestion.transaction_submissions (event_id);
CREATE INDEX ix_txn_tenant_account_time ON ingestion.transaction_submissions (tenant_id, account_id, occurred_at DESC);
CREATE INDEX ix_txn_source_file ON ingestion.transaction_submissions (source_file_id) WHERE source_file_id IS NOT NULL;
```

### 7.3 Schema `files` (Owner: files)

#### files.files
```sql
CREATE TABLE files.files (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),   -- fileId
  tenant_id          UUID NOT NULL,
  uploaded_by        UUID,                                         -- null for WEBHOOK_ATTACHMENT / CONNECTOR_FETCH
  original_filename  TEXT NOT NULL,                                -- sanitized, display only
  storage_bucket     TEXT NOT NULL,
  storage_key        TEXT NOT NULL,                                -- raw/{tenantId}/{yyyy}/{mm}/{dd}/{fileId}
  content_type       TEXT NOT NULL CHECK (content_type IN ('application/pdf','text/html','text/csv','application/json','text/plain')),
  detected_type      TEXT,                                         -- magic-byte sniff result
  size_bytes         BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 536870912),
  sha256_checksum    CHAR(64) NOT NULL,                            -- declared at init
  verified_sha256    CHAR(64),                                     -- computed at validation
  source_type        TEXT NOT NULL CHECK (source_type IN ('AD_HOC_UPLOAD','WEBHOOK_ATTACHMENT','CONNECTOR_FETCH')),
  source_url         TEXT,                                         -- remote fetches only
  purpose            TEXT NOT NULL CHECK (purpose IN ('FILING','REGULATORY_DOCUMENT','TRANSACTION_BATCH','OTHER')),
  related_entity_ids UUID[] NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL CHECK (status IN ('INITIATED','UPLOADED','VALIDATED','PROCESSING','PROCESSED','FAILED','QUARANTINED','EXPIRED')),
  failure_reason     TEXT,
  multipart_upload_id TEXT,
  extractor_version  TEXT,
  correlation_id     TEXT NOT NULL,
  version            INT NOT NULL DEFAULT 0,                       -- optimistic locking
  deleted_at         TIMESTAMPTZ,
  purged_at          TIMESTAMPTZ,                                  -- tombstone after retention purge
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_files_storage_key ON files.files (storage_bucket, storage_key);
CREATE INDEX ix_files_tenant_sha ON files.files (tenant_id, sha256_checksum) WHERE status NOT IN ('FAILED','EXPIRED') AND deleted_at IS NULL;
CREATE INDEX ix_files_tenant_status_created ON files.files (tenant_id, status, created_at DESC);
CREATE INDEX ix_files_initiated_age ON files.files (created_at) WHERE status = 'INITIATED';
```

#### files.file_status_history
```sql
CREATE TABLE files.file_status_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  file_id     UUID NOT NULL REFERENCES files.files(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  reason      TEXT,
  actor       TEXT NOT NULL,                       -- user id, 'system', or service name
  event_id    UUID,                                -- triggering message, if any
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_file_status_history_file ON files.file_status_history (file_id, created_at);
```

#### files.file_artifacts
```sql
CREATE TABLE files.file_artifacts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  file_id            UUID NOT NULL REFERENCES files.files(id),
  extractor_version  TEXT NOT NULL,
  result_status      TEXT NOT NULL CHECK (result_status IN ('COMPLETED','REVIEW_REQUIRED')),
  confidence         NUMERIC(4,3) NOT NULL,
  text_key           TEXT,
  chunks_key         TEXT,
  extraction_key     TEXT NOT NULL,
  row_errors_key     TEXT,                          -- TRANSACTION_BATCH only
  rows_accepted      INT,
  rows_rejected      INT,
  summary            JSONB NOT NULL,                -- eventTypeGuess, entity count, red flags
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_artifacts_file_version ON files.file_artifacts (file_id, extractor_version);
```

### 7.4 Schema `cases` (Owner: cases)

#### cases.risk_evaluations
```sql
CREATE TABLE cases.risk_evaluations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL,
  idempotency_key       TEXT NOT NULL,                -- risk-eval:{eventId}
  transaction_event_id  UUID NOT NULL,
  transaction_id        UUID NOT NULL,
  account_id            TEXT NOT NULL,
  counterparty_id       TEXT NOT NULL,
  score                 INT NOT NULL CHECK (score BETWEEN 0 AND 100),
  band                  TEXT NOT NULL CHECK (band IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  factors               JSONB NOT NULL,               -- [{name,value,contribution}]
  model_version         TEXT NOT NULL,
  feature_version       TEXT NOT NULL,
  watchlist_hits        JSONB NOT NULL DEFAULT '[]',
  case_id               UUID,
  suppressed_reason     TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_risk_eval_idem ON cases.risk_evaluations (tenant_id, idempotency_key);
CREATE INDEX ix_risk_eval_tenant_time ON cases.risk_evaluations (tenant_id, created_at DESC);
CREATE INDEX ix_risk_eval_case ON cases.risk_evaluations (case_id) WHERE case_id IS NOT NULL;
```

#### cases.case_number_sequences
```sql
CREATE TABLE cases.case_number_sequences (
  tenant_id   UUID NOT NULL,
  year        INT NOT NULL,
  next_value  INT NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, year)
);
```

#### cases.cases
```sql
CREATE TABLE cases.cases (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL,
  case_number           TEXT NOT NULL,                -- AP-{yyyy}-{000001}
  case_type             TEXT NOT NULL CHECK (case_type IN ('TRANSACTION_RISK','DOCUMENT_RISK','EXTRACTION_REVIEW','CORRELATED')),
  status                TEXT NOT NULL CHECK (status IN ('OPEN','ENRICHING','POLICY_EVALUATED','ESCALATED','CLEARED','RESOLVED')),
  severity              TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  policy_score          INT CHECK (policy_score BETWEEN 0 AND 100),
  policy_version        TEXT,
  primary_entity_ids    UUID[] NOT NULL DEFAULT '{}',
  trigger_event_id      UUID NOT NULL,
  trigger_file_id       UUID,
  open_idempotency_key  TEXT NOT NULL,
  previous_case_id      UUID REFERENCES cases.cases(id),
  assignee_user_id      UUID,
  pending_disposition   TEXT CHECK (pending_disposition IN ('NEEDS_REVIEW')),
  pending_reviewer_id   UUID,                          -- four-eyes: who recorded NEEDS_REVIEW
  enrichment_deadline   TIMESTAMPTZ,
  resolved_at           TIMESTAMPTZ,
  version               INT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_cases_tenant_number ON cases.cases (tenant_id, case_number);
CREATE UNIQUE INDEX ux_cases_open_idem ON cases.cases (tenant_id, open_idempotency_key);
CREATE INDEX ix_cases_tenant_status_sev ON cases.cases (tenant_id, status, severity, created_at DESC);
CREATE INDEX ix_cases_entities ON cases.cases USING gin (primary_entity_ids);
CREATE INDEX ix_cases_enrichment_deadline ON cases.cases (enrichment_deadline) WHERE status = 'ENRICHING';
CREATE INDEX ix_cases_assignee ON cases.cases (tenant_id, assignee_user_id) WHERE assignee_user_id IS NOT NULL;
```

#### cases.case_transitions
```sql
CREATE TABLE cases.case_transitions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  case_id         UUID NOT NULL REFERENCES cases.cases(id),
  transition_key  TEXT NOT NULL,                    -- idempotency, e.g. policy:{revision}
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  trigger_type    TEXT NOT NULL CHECK (trigger_type IN ('EVENT','USER','TIMER','SYSTEM')),
  trigger_ref     TEXT,                             -- eventId / userId / job name
  case_version    INT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_case_transition_key ON cases.case_transitions (case_id, transition_key);
CREATE INDEX ix_case_transitions_case ON cases.case_transitions (case_id, created_at);
```

#### cases.policy_evaluations
```sql
CREATE TABLE cases.policy_evaluations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  case_id         UUID NOT NULL REFERENCES cases.cases(id),
  revision        INT NOT NULL,                     -- increments per evaluation of a case
  policy_version  TEXT NOT NULL,
  policy_score    INT NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('ESCALATED','CLEARED')),
  factors         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_policy_eval_case_rev ON cases.policy_evaluations (case_id, revision);
```

#### cases.case_evidence
```sql
CREATE TABLE cases.case_evidence (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  case_id         UUID NOT NULL REFERENCES cases.cases(id),
  evidence_type   TEXT NOT NULL CHECK (evidence_type IN ('EVENT','FILE','EXTRACTION','RISK_EVALUATION','WATCHLIST_HIT')),
  evidence_ref    TEXT NOT NULL,                    -- eventId / fileId / evaluationId / watchlistId
  final_severity  TEXT,
  summary         JSONB NOT NULL DEFAULT '{}',
  attached_by     TEXT NOT NULL,                    -- saga name or user id
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_case_evidence ON cases.case_evidence (case_id, evidence_type, evidence_ref);
```

#### cases.case_notes
```sql
CREATE TABLE cases.case_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  case_id     UUID NOT NULL REFERENCES cases.cases(id),
  author_id   UUID NOT NULL,
  body        TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  locked_at   TIMESTAMPTZ NOT NULL,                 -- created_at + 15 min; edits rejected after
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_case_notes_case ON cases.case_notes (case_id, created_at);
```

#### cases.case_dispositions
```sql
CREATE TABLE cases.case_dispositions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  case_id          UUID NOT NULL REFERENCES cases.cases(id),
  disposition      TEXT NOT NULL CHECK (disposition IN ('TRUE_POSITIVE','FALSE_POSITIVE','NEEDS_REVIEW')),
  rationale        TEXT NOT NULL CHECK (char_length(rationale) >= 20),
  analyst_id       UUID NOT NULL,
  model_versions   TEXT[] NOT NULL DEFAULT '{}',
  rule_versions    TEXT[] NOT NULL DEFAULT '{}',
  policy_version   TEXT,
  idempotency_key  TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_dispositions_idem ON cases.case_dispositions (tenant_id, idempotency_key);
CREATE INDEX ix_dispositions_case ON cases.case_dispositions (case_id, created_at);
```

#### cases.audit_log
```sql
CREATE TABLE cases.audit_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  seq               BIGINT NOT NULL,                -- per-tenant, gapless, assigned under advisory lock
  occurred_at       TIMESTAMPTZ NOT NULL,
  actor_type        TEXT NOT NULL CHECK (actor_type IN ('USER','SERVICE','SYSTEM')),
  actor_id          TEXT NOT NULL,
  acting_as         TEXT,                           -- PLATFORM_ADMIN cross-tenant context
  action            TEXT NOT NULL,                  -- e.g. CASE_TRANSITION, CLASSIFICATION_OVERRIDE
  subject_type      TEXT NOT NULL,
  subject_id        TEXT NOT NULL,
  trigger_event_id  UUID,
  trigger_file_id   UUID,
  model_version     TEXT,
  rule_version      TEXT,
  before_state      JSONB,
  after_state       JSONB,
  source_event_id   UUID,                           -- idempotency for ingested audit events
  prev_hash         CHAR(64) NOT NULL,              -- '0'*64 for seq 1
  hash              CHAR(64) NOT NULL,              -- sha256(canonical_json(entry) || prev_hash)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_audit_tenant_seq ON cases.audit_log (tenant_id, seq);
CREATE UNIQUE INDEX ux_audit_source_event ON cases.audit_log (tenant_id, source_event_id) WHERE source_event_id IS NOT NULL;
CREATE INDEX ix_audit_subject ON cases.audit_log (tenant_id, subject_type, subject_id, occurred_at DESC);
CREATE INDEX ix_audit_actor ON cases.audit_log (tenant_id, actor_id, occurred_at DESC);

CREATE FUNCTION cases.reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE OR DELETE ON cases.audit_log
  FOR EACH ROW EXECUTE FUNCTION cases.reject_audit_mutation();
CREATE TRIGGER trg_audit_no_truncate BEFORE TRUNCATE ON cases.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION cases.reject_audit_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON cases.audit_log FROM svc_cases;
```

#### cases.audit_chain_heads
```sql
CREATE TABLE cases.audit_chain_heads (               -- O(1) lookup of last hash per tenant
  tenant_id     UUID PRIMARY KEY,
  last_seq      BIGINT NOT NULL,
  last_hash     CHAR(64) NOT NULL,
  verified_seq  BIGINT NOT NULL DEFAULT 0,          -- last seq verified by nightly job
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 7.5 Schema `analytics` (Owner: data-intel)

#### analytics.fact_risk_scores
```sql
CREATE TABLE analytics.fact_risk_scores (
  event_id        UUID PRIMARY KEY,                 -- risk.evaluation.recorded eventId (idempotency)
  tenant_id       UUID NOT NULL,
  evaluation_id   UUID NOT NULL,
  score           INT NOT NULL,
  band            TEXT NOT NULL,
  model_version   TEXT NOT NULL,
  entity_ids      UUID[] NOT NULL DEFAULT '{}',
  occurred_at     TIMESTAMPTZ NOT NULL,
  latency_ms      INT,                               -- recorded - txn occurred
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_frs_tenant_time ON analytics.fact_risk_scores (tenant_id, occurred_at);
CREATE INDEX ix_frs_model ON analytics.fact_risk_scores (model_version, occurred_at);
```

#### analytics.fact_classifications
```sql
CREATE TABLE analytics.fact_classifications (
  event_id                   UUID PRIMARY KEY,      -- classification.finalized/overridden eventId
  tenant_id                  UUID NOT NULL,
  subject_event_id           UUID NOT NULL,
  subject_event_type         TEXT NOT NULL,
  source                     TEXT NOT NULL,
  publisher_stated_severity  TEXT,
  algorithm_severity         TEXT NOT NULL,
  final_severity             TEXT NOT NULL,
  algorithm_confidence       NUMERIC(4,3),
  classification_source      TEXT NOT NULL,
  classifier_version         TEXT,
  rule_version               TEXT NOT NULL,
  overridden                 BOOLEAN NOT NULL DEFAULT FALSE,
  ingest_latency_ms          INT,                    -- ingestedAt - occurredAt
  archive_latency_ms         INT,                    -- archivedAt - ingestedAt
  occurred_at                TIMESTAMPTZ NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_fc_tenant_source_time ON analytics.fact_classifications (tenant_id, source, occurred_at);
```

#### analytics.fact_extractions
```sql
CREATE TABLE analytics.fact_extractions (
  event_id           UUID PRIMARY KEY,
  tenant_id          UUID NOT NULL,
  file_id            UUID NOT NULL,
  extractor_version  TEXT NOT NULL,
  result_status      TEXT NOT NULL,
  confidence         NUMERIC(4,3) NOT NULL,
  entity_count       INT NOT NULL,
  red_flag_count     INT NOT NULL,
  processing_ms      INT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_fe_tenant_time ON analytics.fact_extractions (tenant_id, occurred_at);
```

#### analytics.fact_case_events
```sql
CREATE TABLE analytics.fact_case_events (
  event_id        UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  case_id         UUID NOT NULL,
  case_type       TEXT NOT NULL,
  event_type      TEXT NOT NULL,                    -- case.opened|transitioned|...|disposition.recorded
  to_status       TEXT,
  severity        TEXT,
  disposition     TEXT,
  model_versions  TEXT[] NOT NULL DEFAULT '{}',
  rule_versions   TEXT[] NOT NULL DEFAULT '{}',
  policy_version  TEXT,
  entity_ids      UUID[] NOT NULL DEFAULT '{}',
  occurred_at     TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_fce_tenant_time ON analytics.fact_case_events (tenant_id, occurred_at);
CREATE INDEX ix_fce_disposition ON analytics.fact_case_events (tenant_id, disposition) WHERE disposition IS NOT NULL;
```

#### analytics.fact_file_status
```sql
CREATE TABLE analytics.fact_file_status (
  event_id     UUID PRIMARY KEY,
  tenant_id    UUID NOT NULL,
  file_id      UUID NOT NULL,
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_ffs_tenant_time ON analytics.fact_file_status (tenant_id, occurred_at);
```

#### analytics.rollup_entity_risk_daily
```sql
CREATE TABLE analytics.rollup_entity_risk_daily (
  tenant_id        UUID NOT NULL,
  entity_id        UUID NOT NULL,
  day              DATE NOT NULL,
  txn_count        INT NOT NULL,
  mean_score       NUMERIC(5,2) NOT NULL,
  max_score        INT NOT NULL,
  high_plus_count  INT NOT NULL,
  case_count       INT NOT NULL,
  high_sev_signals INT NOT NULL,                     -- external/doc events ≥ HIGH mentioning entity
  computed_at      TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, entity_id, day)
);
```

#### analytics.rollup_source_reliability_daily
```sql
CREATE TABLE analytics.rollup_source_reliability_daily (
  tenant_id           UUID NOT NULL,
  source              TEXT NOT NULL,
  day                 DATE NOT NULL,
  event_count         INT NOT NULL,
  disagreement_count  INT NOT NULL,                  -- publisher_stated ≠ algorithm (both present)
  disagreement_rate   NUMERIC(5,4) NOT NULL,
  override_count      INT NOT NULL,
  p50_latency_ms      INT,
  p95_latency_ms      INT,
  computed_at         TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, source, day)
);
```

#### analytics.rollup_exposure_daily
```sql
CREATE TABLE analytics.rollup_exposure_daily (
  tenant_id     UUID NOT NULL,
  category      TEXT NOT NULL,                       -- REGULATORY, FINANCIAL, MNPI, event category
  day           DATE NOT NULL,
  event_count   INT NOT NULL,
  high_plus     INT NOT NULL,
  critical      INT NOT NULL,
  computed_at   TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, category, day)
);
```

#### analytics.drift_metrics
```sql
CREATE TABLE analytics.drift_metrics (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID,                                  -- null = platform-wide
  metric      TEXT NOT NULL CHECK (metric IN ('RISK_SCORE_PSI','EXTRACTION_CONFIDENCE_DROP','SEVERITY_DISAGREEMENT_RATE')),
  scope       TEXT NOT NULL,                         -- model version / source / extractor version
  window_start TIMESTAMPTZ NOT NULL,
  window_end   TIMESTAMPTZ NOT NULL,
  value       NUMERIC(8,4) NOT NULL,
  threshold   NUMERIC(8,4) NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('NONE','MEDIUM','HIGH')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_drift_window ON analytics.drift_metrics (coalesce(tenant_id,'00000000-0000-0000-0000-000000000000'), metric, scope, window_end);
CREATE INDEX ix_drift_breaches ON analytics.drift_metrics (created_at DESC) WHERE severity <> 'NONE';
```

#### analytics.eval_runs
```sql
CREATE TABLE analytics.eval_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_key           TEXT NOT NULL,                   -- git sha + dataset version (idempotency)
  git_sha           TEXT NOT NULL,
  dataset_version   TEXT NOT NULL,
  component         TEXT NOT NULL CHECK (component IN ('EXTRACTION','SCANNER','SCORING','WEBHOOK_ADVERSARIAL','IDEMPOTENCY')),
  component_version TEXT NOT NULL,
  metrics           JSONB NOT NULL,                  -- precision/recall/f1/etc.
  passed            BOOLEAN NOT NULL,
  report_key        TEXT,                            -- object-store key of full report
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_eval_runs_key ON analytics.eval_runs (run_key, component);
```

### 7.6 MongoDB (`aegispulse_events`, Owner: events)

Collections use `$jsonSchema` validators (`validationLevel: strict`) generated from `packages/contracts`; indexes via `migrate-mongo` in `services/events/src/db/mongo-migrations/`.

| Collection | Key fields | Indexes |
|---|---|---|
| `events_archive` | `tenantId, eventId, correlationId, causationId, eventType, source, exchange, routingKey, schemaVersion, occurredAt, ingestedAt, archivedAt, idempotencyKey, classification{…, revision}, status, statusHistory[{status, at, by}], classificationHistory[{stage, source, sensitivity, severity, confidence, version, at, actor?, justification?}], payload (redacted), redactions[{path, rule, kind}], payloadSha256, mentionedEntityIds[], pendingAiScan, replay{count, lastReplayedAt, lastJobId}, expireAt` | unique `{tenantId:1, eventId:1}`; `{tenantId:1, correlationId:1, occurredAt:-1}`; `{tenantId:1, "classification.final_severity":1, occurredAt:-1}`; `{status:1, occurredAt:1}`; `{tenantId:1, eventType:1, occurredAt:-1}`; `{tenantId:1, mentionedEntityIds:1, occurredAt:-1}`; `{pendingAiScan:1, archivedAt:1}` partial `pendingAiScan:true`; TTL `{expireAt:1}` `expireAfterSeconds:0` |
| `events_restricted_audit` | same shape | same indexes; TTL expireAt = archivedAt + 7 y |
| `outbox` | `eventId, exchange, routingKey, envelope, status, attempts, availableAt, sentAt` | unique `{eventId:1}`; `{status:1, availableAt:1}`; TTL on `sentAt` 7 d |
| `processed_messages` | `consumer, eventId, replayGeneration, processedAt` | unique `{consumer:1, eventId:1, replayGeneration:1}`; TTL `processedAt` 14 d |
| `replay_jobs` | `jobId, tenantId|null, requestedBy, filter, target, reason, dryRun, maxEvents, status, matchedCount, publishedCount, lastCheckpoint{occurredAt, eventId}, generation, createdAt, startedAt, finishedAt, error` | unique `{jobId:1}`; `{status:1, createdAt:1}`; `{tenantId:1, createdAt:-1}` |
| `dead_letters` | `tenantId, eventId, eventType, queue, routingKey, envelope, rawBody (poison that is not a JSON object), bodySha256, headers, errorCode, errorMessage, stackHash, retryCount, occurrences, firstFailedAt, lastFailedAt, status (OPEN|REPLAYED|DISCARDED), resolvedBy, resolvedAt, reason`; `identityKey` (`{tenantId|-}|{eventId | sha256:{bodySha256}}`), `queueHeaderMismatch`, `expireAt` (resolvedAt + 30 days); one OPEN record per (queue, identityKey); the stored message is kept unmasked only for replay, every API view is masked by the rules-v1 detectors (§1.4.2) | unique `{queue:1, eventId:1, lastFailedAt:1}`; partial unique `{queue:1, identityKey:1}` where `status = OPEN`; TTL `{expireAt:1}` (resolved records only); `{tenantId:1, status:1, lastFailedAt:-1}`; `{errorCode:1}` |
| `leases` | `name, holder, expiresAt` | unique `{name:1}` (replay runner, sweeps) |
| `schema_meta` | `version, appliedAt` | — |

### 7.7 Redis Keyspace

| Key pattern | Owner | Type / TTL | Purpose |
|---|---|---|---|
| `whk:nonce:{sourceId}:{deliveryId}` | ingestion | string, 900 s | webhook replay guard |
| `idem:ingestion:{tenantId}:{scope}:{key}` | ingestion | string, 60 s | in-flight lock for idempotent requests |
| `upload:session:{fileId}` | files | hash, 900 s | presigned upload session (tenantId, uploader, size, sha256) |
| `file:dedup:{tenantId}:{sha256}` | files | string(fileId), 24 h | duplicate upload detection |
| `file:status:{fileId}` | files | string(JSON), 30 s | hot status cache |
| `file:dlurl:{fileId}:{principal}` | files | string, 240 s | cached presigned GET (< 300 s URL TTL) |
| `quota:files:{tenantId}` | files | token bucket, 120 s | init rate limit |
| `feat:txn1h:{tenantId}:{accountId}` | risk-scoring | zset, 2 h | velocity window |
| `feat:cp:{tenantId}:{accountId}` | risk-scoring | hash(counterpartyId→lastSeen), 30 d | new-counterparty feature |
| `feat:seen:{tenantId}:{eventId}` | risk-scoring | string, 48 h | feature-update idempotency |
| `ratelimit:auth:{tenantId}:{emailHash}` | registry | counter, 900 s | login throttling (unknown tenant → nil UUID) |
| `ratelimit:cc:{clientIdHash}` | registry | counter, 300 s | client-credentials throttling (FR-AUTH-04) |
| `auth:jwks:cache` | registry | string, 600 s | serialized JWKS |

### 7.8 Object Storage Layout

| Bucket | Prefix | Writer | Notes |
|---|---|---|---|
| `aegispulse-{env}-raw` | `raw/{tenantId}/{yyyy}/{mm}/{dd}/{fileId}` | client (presigned) / files | immutable; versioning on |
| `aegispulse-{env}-raw` | `raw/webhooks/{tenantId}/{yyyy}/{mm}/{dd}/{deliveryUuid}.json` | ingestion | raw webhook bodies |
| `aegispulse-{env}-quarantine` | `quarantine/{tenantId}/{fileId}` | files | 30-day lifecycle; admin-only download |
| `aegispulse-{env}-artifacts` | `artifacts/{tenantId}/{fileId}/{extractorVersion}/{text.txt|chunks.jsonl|extraction.json|row-errors.csv}` | doc-extraction | deterministic keys |
| `aegispulse-{env}-archive` | `archive/{tenantId}/{yyyy}/{mm}/events-{part}.parquet` | events | cold tier (Phase 15) |
| `aegispulse-{env}-analytics` | `analytics/{table}/dt={yyyy-mm-dd}/part-0.parquet` | data-intel | daily exports |
| `aegispulse-{env}-backups` | `backups/{postgres|mongo}/{yyyy-mm-dd}/…` | backup CronJobs | versioning on |

---

## 8. API Documentation

### 8.1 Base URLs

| Environment | API URL | Web App URL | Webhook URL pattern |
|---|---|---|---|
| local | `http://localhost:8080` | `http://localhost:5173` | `http://localhost:8080/webhooks/{sourceKey}` |
| dev | `https://aegispulse-api.rmwhs-dev.space` | `https://aegispulse.rmwhs-dev.space` | `https://aegispulse-api.rmwhs-dev.space/webhooks/{sourceKey}` |
| prod | `https://aegispulse-api.rmwhs.com` | `https://aegispulse.rmwhs.com` | `https://aegispulse-api.rmwhs.com/webhooks/{sourceKey}` |
| AWS production (reference) | `https://api.aegispulse.<domain>` | `https://app.aegispulse.<domain>` | same pattern |

Public contract: `packages/contracts/openapi/gateway.public.yaml` (served at `/v1/openapi.json`, used by ZAP API scan). Internal contracts: `{service}.internal.yaml`.

### 8.2 Response Envelope

Success:
```json
{ "data": { "...": "..." }, "meta": { "requestId": "req_01J…", "correlationId": "corr-…", "nextCursor": "eyJ…" } }
```
Error:
```json
{ "error": { "code": "CASE_INVALID_TRANSITION", "message": "Case AP-2026-000042 cannot move from RESOLVED to ENRICHING.",
             "details": [{ "field": "status", "issue": "terminal_state" }] },
  "meta": { "requestId": "req_01J…", "correlationId": "corr-…", "traceId": "4bf92f3577b34da6a3ce929d0e0e4736" } }
```
`202 Accepted` responses return `data` with the created ids and `eventId`. Webhook responses use the same envelope.

### 8.3 Endpoints

🔒 = Bearer JWT required (validated against Registry JWKS by the gateway **and** by the owning service). Roles abbreviated: PA platform admin, TA tenant admin, AN analyst, VI viewer, CA compliance auditor, IN integration.

**Auth & Identity (registry)**

| Method | Path | Description |
|---|---|---|
| POST | `/v1/auth/login` | tenant slug + email + password → access + refresh tokens |
| POST | `/v1/auth/refresh` | rotate refresh token |
| POST | `/v1/auth/logout` 🔒 | revoke refresh family |
| POST | `/v1/auth/password` 🔒 | change password |
| GET | `/v1/auth/me` 🔒 | current principal |
| POST | `/v1/auth/token` | client-credentials token (IN) |
| GET | `/.well-known/jwks.json` | public signing keys (bare RFC 7517 JWK Set, not the §8.2 envelope) |
| GET | `/v1/openapi.json` | bundled public OpenAPI document, served from `packages/contracts` (used by ZAP API scans) |

**Tenants, Users, Service Accounts (registry)**

| Method | Path | Description |
|---|---|---|
| POST | `/v1/tenants` 🔒 PA | create tenant |
| GET | `/v1/tenants/{tenantId}` 🔒 PA/TA | tenant detail + settings |
| PATCH | `/v1/tenants/{tenantId}` 🔒 PA/TA | settings (TA) or status (PA) |
| GET | `/v1/users` 🔒 TA, PA via `X-Aegis-Tenant` | list users |
| POST | `/v1/users` 🔒 TA, PA via `X-Aegis-Tenant` | create user |
| PATCH | `/v1/users/{userId}` 🔒 TA, PA via `X-Aegis-Tenant` | roles / status / display name |
| GET | `/v1/service-accounts` 🔒 TA | list |
| POST | `/v1/service-accounts` 🔒 TA | create (secret returned once) |
| POST | `/v1/service-accounts/{id}/rotate-secret` 🔒 TA | rotate |
| DELETE | `/v1/service-accounts/{id}` 🔒 TA | revoke |

**Entities & Watchlists (registry)**

| Method | Path | Description |
|---|---|---|
| GET | `/v1/entities` 🔒 VI+ | list/search (`q`, `type`, `watchlistId`) |
| POST | `/v1/entities` 🔒 AN+ | create |
| GET | `/v1/entities/{id}` 🔒 VI+ | detail + aliases + watchlists |
| PATCH | `/v1/entities/{id}` 🔒 AN+ | update / aliases |
| DELETE | `/v1/entities/{id}` 🔒 TA | archive |
| GET | `/v1/watchlists` 🔒 VI+ | list |
| POST | `/v1/watchlists` 🔒 AN+ | create |
| PATCH | `/v1/watchlists/{id}` 🔒 AN+ | update / pause |
| DELETE | `/v1/watchlists/{id}` 🔒 TA | soft delete |
| POST | `/v1/watchlists/{id}/entries` 🔒 AN+ | add entity |
| DELETE | `/v1/watchlists/{id}/entries/{entityId}` 🔒 AN+ | remove entity |

**Webhooks & Connectors (ingestion)**

| Method | Path | Description |
|---|---|---|
| POST | `/webhooks/{sourceKey}` | HMAC-signed inbound webhook (no JWT) |
| GET | `/v1/webhook-sources` 🔒 TA | list |
| POST | `/v1/webhook-sources` 🔒 TA | register (secret returned once) |
| PATCH | `/v1/webhook-sources/{id}` 🔒 TA | status / trust / hosts |
| POST | `/v1/webhook-sources/{id}/rotate-secret` 🔒 TA | rotate (dual-key window 72 h) |
| DELETE | `/v1/webhook-sources/{id}` 🔒 TA | soft delete |
| GET | `/v1/webhook-sources/{id}/deliveries` 🔒 TA | delivery metadata |
| GET | `/v1/connectors` 🔒 TA | list |
| POST | `/v1/connectors` 🔒 TA | create |
| PATCH | `/v1/connectors/{id}` 🔒 TA | update / enable / disable |
| DELETE | `/v1/connectors/{id}` 🔒 TA | soft delete |
| POST | `/v1/connectors/{id}/run` 🔒 TA | run now (1/min) |

**Transactions (ingestion + cases composition)**

| Method | Path | Description |
|---|---|---|
| POST | `/v1/transactions` 🔒 IN/AN+ | submit transaction (202) |
| GET | `/v1/transactions/{id}` 🔒 IN(own)/VI+ | status + evaluation + case |

**Files (files)**

| Method | Path | Description |
|---|---|---|
| POST | `/v1/files/uploads/init` 🔒 IN/AN+ | init (presigned PUT or dedup hit) |
| POST | `/v1/files/uploads/{fileId}/complete` 🔒 IN/AN+ | complete |
| POST | `/v1/files/uploads/{fileId}/abort` 🔒 IN/AN+ | abort (INITIATED → EXPIRED) |
| GET | `/v1/files` 🔒 VI+ | list |
| GET | `/v1/files/{fileId}` 🔒 VI+ | metadata + status + artifacts summary |
| GET | `/v1/files/{fileId}/download-url` 🔒 AN+ | presigned GET |
| DELETE | `/v1/files/{fileId}` 🔒 TA | soft delete |

**Events, Classification & Replay (events)**

| Method | Path | Description |
|---|---|---|
| GET | `/v1/events` 🔒 VI+ (`tier=restricted` CA) | search archive |
| GET | `/v1/events/{eventId}` 🔒 VI+ | detail with lineage |
| GET | `/v1/events/correlation/{correlationId}` 🔒 VI+ | causal chain |
| PATCH | `/v1/events/{eventId}/classification` 🔒 AN+ | analyst override |
| POST | `/v1/events/replay` 🔒 TA/PA | create replay job |
| GET | `/v1/events/replay/{jobId}` 🔒 TA/PA | job status |
| POST | `/v1/events/replay/{jobId}/cancel` 🔒 TA/PA | cancel |

**Cases & Audit (cases)**

| Method | Path | Description |
|---|---|---|
| GET | `/v1/cases` 🔒 VI+ | list/filter |
| GET | `/v1/cases/{caseId}` 🔒 VI+ | detail |
| GET | `/v1/cases/{caseId}/timeline` 🔒 VI+ | transitions + evidence + notes + dispositions |
| POST | `/v1/cases/{caseId}/assign` 🔒 AN+ | assign/unassign (`expectedVersion`) |
| POST | `/v1/cases/{caseId}/notes` 🔒 AN+ | add note |
| POST | `/v1/cases/{caseId}/dispositions` 🔒 AN+ | record disposition |
| POST | `/v1/cases/{caseId}/reevaluate` 🔒 AN+ | manual re-evaluation |
| GET | `/v1/audit` 🔒 CA/TA | audit entries |
| GET | `/v1/audit/verify` 🔒 CA | chain verification |

**Intelligence (data-intel)**

| Method | Path | Description |
|---|---|---|
| GET | `/v1/intel/summary` 🔒 AN+ | KPIs |
| GET | `/v1/intel/drift` 🔒 AN+ | drift metrics |
| GET | `/v1/intel/disagreement` 🔒 AN+ | publisher vs algorithm by source |
| GET | `/v1/intel/latency` 🔒 AN+ | pipeline latency percentiles |
| GET | `/v1/intel/precision` 🔒 AN+ | precision by model/rule/policy version |
| GET | `/v1/intel/eval-runs` 🔒 AN+ | evaluation history |

**Ops & Streaming (events / gateway)**

| Method | Path | Description |
|---|---|---|
| GET | `/v1/ops/dead-letters` 🔒 PA/TA | list |
| GET | `/v1/ops/dead-letters/{id}` 🔒 PA/TA | detail |
| POST | `/v1/ops/dead-letters/{id}/replay` 🔒 PA/TA | replay to original queue |
| POST | `/v1/ops/dead-letters/{id}/discard` 🔒 PA/TA | discard with reason |
| GET | `/v1/stream` 🔒 VI+ | SSE pipeline stream |
| GET | `/livez` · `/readyz` · `/healthz` | probes (every runtime; `/healthz` internal only) |

**JWT validation note:** the gateway verifies signature (RS256, `kid` from cached JWKS), `iss`, `aud`, `exp`/`nbf` (60 s leeway), and `typ`; it derives the auth context (tenant, roles) and forwards the original `Authorization` header plus `X-Request-Id`, `X-Correlation-Id`, `traceparent`. The owning service re-verifies the token and enforces RBAC + tenant ownership itself. Internal SERVICE tokens additionally require `aud=aegispulse-internal` and an `act[]` containing the invoked action. **`typ` rule (ADR-0010):** `typ` must be exactly `user` or `integration` on `aud=JWT_AUDIENCE` (with `tid`, `tslug`, `roles[]`, `jti`; integration tokens carry only the `INTEGRATION` role) or exactly `service` on `aud=aegispulse-internal` (with `act[]`, `jti`); a missing or unknown `typ`, or a `typ` presented on the other audience, is rejected with `401 UNAUTHORIZED`.

### 8.4 Error Codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 422 | Body/query failed schema validation (`details[]` lists fields) |
| `BAD_REQUEST` | 400 | Malformed JSON or unsupported content type |
| `UNAUTHORIZED` | 401 | Missing/invalid/expired token |
| `FORBIDDEN` | 403 | Authenticated but role lacks permission |
| `NOT_FOUND` | 404 | Resource absent **or belongs to another tenant** |
| `CONFLICT` | 409 | Generic state conflict |
| `PAYLOAD_TOO_LARGE` | 413 | Body exceeds route limit |
| `RATE_LIMITED` | 429 | Generic rate limit |
| `INTERNAL_ERROR` | 500 | Unhandled failure (traceId provided) |
| `DEPENDENCY_UNAVAILABLE` | 503 | Required downstream unavailable/circuit open (sync paths only) |
| `AUTH_INVALID_CREDENTIALS` | 401 | Login failed (uniform message) |
| `AUTH_RATE_LIMITED` | 429 | Too many login attempts |
| `AUTH_REFRESH_INVALID` | 401 | Refresh token invalid, expired, or reused |
| `AUTH_PASSWORD_POLICY` | 422 | Password fails policy |
| `TENANT_SUSPENDED` | 403 | Tenant suspended/deactivated |
| `TENANT_SLUG_TAKEN` | 409 | Duplicate tenant slug |
| `LAST_TENANT_ADMIN` | 409 | Would remove the last tenant admin |
| `USER_EMAIL_TAKEN` | 409 | Duplicate email in tenant |
| `ENTITY_DUPLICATE` | 409 | Normalized entity name exists |
| `WATCHLIST_NAME_TAKEN` | 409 | Duplicate watchlist name |
| `WEBHOOK_SOURCE_NOT_FOUND` | 404 | Unknown or disabled source key |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | HMAC mismatch / missing headers |
| `WEBHOOK_TIMESTAMP_SKEW` | 401 | Timestamp outside ±300 s |
| `WEBHOOK_REPLAY_DETECTED` | 409 | Delivery id already seen |
| `WEBHOOK_SOURCE_KEY_TAKEN` | 409 | Duplicate source key |
| `CONNECTOR_RUN_THROTTLED` | 429 | Manual run within 1 min |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Same key, different request body |
| `IDEMPOTENCY_KEY_REQUIRED` | 422 | Endpoint requires idempotency key |
| `FILE_TYPE_NOT_ALLOWED` | 422 | Content type not in allowlist |
| `FILE_TOO_LARGE` | 413 | Exceeds size limit |
| `UPLOAD_RATE_LIMITED` | 429 | Tenant init rate exceeded |
| `STORAGE_QUOTA_EXCEEDED` | 413 | Tenant storage quota exceeded |
| `UPLOAD_SESSION_EXPIRED` | 409 | Session missing/expired at complete |
| `UPLOAD_NOT_FOUND_IN_STORAGE` | 409 | Object not present at complete |
| `UPLOAD_SIZE_MISMATCH` | 409 | Stored size ≠ declared size |
| `FILE_NOT_DOWNLOADABLE` | 409 | Status does not permit download |
| `FILE_QUARANTINED` | 403 | Quarantined; acknowledgement + TA role required |
| `EVENT_NOT_FOUND` | 404 | No archived event (or other tenant / restricted tier) |
| `CLASSIFICATION_JUSTIFICATION_REQUIRED` | 422 | Override without ≥ 20-char justification |
| `REPLAY_FILTER_INVALID` | 422 | Zero or multiple filter modes, window > 31 d |
| `REPLAY_TARGET_NOT_ALLOWED` | 422 | Queue not in replay allowlist |
| `REPLAY_JOB_NOT_CANCELLABLE` | 409 | Job already terminal |
| `CASE_NOT_FOUND` | 404 | Unknown case |
| `CASE_INVALID_TRANSITION` | 409 | Transition not in state machine |
| `CASE_CONFLICT` | 409 | Optimistic lock failure after retries / `expectedVersion` mismatch |
| `CASE_FOUR_EYES_REQUIRED` | 409 | Same analyst finalizing a NEEDS_REVIEW case |
| `CASE_NOTE_LOCKED` | 409 | Note edit after 15 min |
| `AUDIT_CHAIN_BROKEN` | 200 (in body) | Reported by verify endpoint, not an HTTP error |
| `DEAD_LETTER_NOT_FOUND` | 404 | Unknown dead letter |
| `DEAD_LETTER_ALREADY_RESOLVED` | 409 | Already replayed/discarded |
| `STREAM_LIMIT` | 429 | Too many concurrent SSE streams |
| `ENVELOPE_INVALID` | — (DLQ header) | Message failed envelope schema validation |


---

## 9. DevOps & Deployment

### 9.1 Environments

| Environment | Purpose | Compute | Deployed by |
|---|---|---|---|
| `local` | development, integration and E2E tests | Docker Compose on developer machine (optional k3d) | `make up` |
| `ci` | unit/integration tests with Testcontainers inside runner pods | GitLab Runner kubernetes executor (namespace `gitlab-runner`) | pipeline |
| `dev` | integration/runtime verification, DAST target, chaos/load/soak, resettable data | k3s namespace `aegispulse-dev`, `*.rmwhs-dev.space` | pipeline on every `main` commit (automatic) |
| `prod` | the portfolio deployment and public demo; never chaos-tested or reset | k3s namespace `aegispulse`, `*.rmwhs.com` | manual promotion of dev-verified digests, or `v*` tag |
| AWS production | reference only (documented, never provisioned) | EKS (§4.2, §5.8) | — |

### 9.2 CI/CD (GitLab)

Pipeline logic lives in `ci/*.sh` (cluster standard §3.2); `.gitlab-ci.yml` stays declarative. Pipelines run for merge requests, for branch pushes without an open MR (so feature branches are verified before an MR exists, without duplicate branch+MR pipelines), for `main` (including schedules) and for `vX.Y.Z` tags; deploy, promotion and release jobs carry their own `rules` restricting them to `main`/tags. Jobs run on the shared runner (tags `default`, `generic`). Per-runtime jobs use `rules:changes` so an MR touching only `services/cases/**` runs Java jobs plus contract/E2E jobs.

```yaml
# .gitlab-ci.yml (shape)
stages: [.pre, lint, test, contract, build, scan, sign, deploy-dev, verify-dev, deploy-prod, verify-prod, release]

workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"   # MR pipelines
    - if: $CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS    # branch with an open MR: the MR pipeline covers it
      when: never
    - if: $CI_COMMIT_BRANCH                               # main, feature branches without an MR, schedules, web runs
    - if: $CI_COMMIT_TAG =~ /^v\d+\.\d+\.\d+$/

include:
  - template: Jobs/Secret-Detection.gitlab-ci.yml        # Gitleaks-based
  - template: Jobs/SAST.gitlab-ci.yml                    # Semgrep analyzers
  - template: Jobs/Dependency-Scanning.gitlab-ci.yml
  - template: Jobs/SAST-IaC.gitlab-ci.yml                # KICS on deploy/k8s
  - template: Jobs/Container-Scanning.gitlab-ci.yml      # Trivy-based, per image

gitleaks:            { stage: .pre,    script: [./ci/scan-gitleaks.sh] }          # full history on main, diff on MR
lint:node:           { stage: lint,    script: [./ci/lint-node.sh] }              # eslint, tsc --noEmit, dependency-cruiser
lint:java:           { stage: lint,    script: [./ci/lint-java.sh] }              # spotless, errorprone
lint:python:         { stage: lint,    script: [./ci/lint-python.sh] }            # ruff, mypy --strict, import-linter
lint:manifests:      { stage: lint,    script: [./ci/lint-k8s.sh] }               # kustomize build | kubeconform | trivy config
check:boundaries:    { stage: lint,    script: [./ci/check-boundaries.sh, ./ci/check-resource-budget.sh] }
test:node:           { stage: test,    script: [./ci/test-node.sh] }              # vitest unit + testcontainers integration
test:java:           { stage: test,    script: [./ci/test-java.sh] }              # JUnit + Testcontainers + ArchUnit
test:python:         { stage: test,    script: [./ci/test-python.sh] }            # pytest + testcontainers
test:console:        { stage: test,    script: [./ci/test-console.sh] }           # vitest + playwright component tests
eval:models:         { stage: test,    script: [./ci/eval.sh], rules: [{changes: [services/{risk-scoring,sensitivity-scanner,doc-extraction}/**/*, eval/**/*]}] }
contract:            { stage: contract, script: [./ci/contract.sh] }              # spectral, asyncapi validate, oasdiff/asyncapi diff vs main, schema conformance
sonarqube:           { stage: contract, script: [./ci/scan-sonar.sh] }            # quality gate wait=true
build:images:        { stage: build,   parallel: { matrix: [{ IMAGE: [gateway, ingestion, files, events, orchestrator, registry, cases, risk-scoring, sensitivity-scanner, doc-extraction, data-intel, console, scheduler-trigger, migrate] }] },
                       image: { name: gcr.io/kaniko-project/executor:debug, entrypoint: [""] }, script: [./ci/build.sh] }
scan:trivy:          { stage: scan,    script: [./ci/scan-trivy.sh] }             # image + SBOM (syft) ; fail on CRITICAL/HIGH fixable
check:layers:        { stage: scan,    script: [./ci/check-layer-sizes.sh] }      # every layer < 95 MB
sign:images:         { stage: sign,    script: [./ci/sign.sh], rules: [{ if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH }, { if: $CI_COMMIT_TAG }] }
deploy:dev:          { stage: deploy-dev, script: [./ci/deploy.sh dev], environment: { name: dev, url: https://aegispulse.rmwhs-dev.space },
                       resource_group: dev, rules: [{ if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH }] }
verify:dev:smoke:    { stage: verify-dev, script: [./ci/smoke.sh dev] }            # full E2E smoke against rmwhs-dev.space
verify:dev:zap:      { stage: verify-dev, script: [./ci/scan-zap.sh dev] }         # ZAP baseline (console) + active API scan (openapi); fail on High
verify:dev:netpol:   { stage: verify-dev, script: [./ci/netpol-test.sh dev] }      # incl. dev→prod isolation probe
deploy:prod:         { stage: deploy-prod, script: [./ci/deploy.sh prod], environment: { name: prod, url: https://aegispulse.rmwhs.com },
                       resource_group: prod, needs: [verify:dev:smoke, verify:dev:zap, verify:dev:netpol],
                       rules: [{ if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH, when: manual }, { if: $CI_COMMIT_TAG }] }   # same digests as dev; never rebuilt
verify:prod:smoke:   { stage: verify-prod, script: [./ci/smoke.sh prod] }          # read-mostly smoke subset; passive ZAP baseline only
verify:prod:rollback: { stage: verify-prod, script: [./ci/rollback.sh prod], when: manual }
env:sleep:dev:       { stage: deploy-dev, script: [./ci/env-sleep.sh dev], rules: [{ if: $CI_PIPELINE_SOURCE == "schedule" }] }   # scale dev to zero nightly
release:             { stage: release, script: [./ci/release.sh], rules: [{ if: $CI_COMMIT_TAG }] }  # GitLab Release + notes from CHANGELOG
```

Merge-request pipeline: `.pre → lint → test → contract → build → scan` (no sign/deploy). `main`: sign → **auto-deploy to dev** → dev verification (smoke, active ZAP, NetworkPolicy) → **manual `deploy:prod`** (gated on dev verification, GitLab protected environment `prod`) → prod smoke. Tags `vX.Y.Z`: promote the already-verified digests of that commit to prod and publish a GitLab Release. Prod never receives a digest that hasn't passed dev verification (`ci/deploy.sh prod` checks `deploy/releases/dev/{sha}.json` exists and is marked verified).

**Deploy script (`ci/deploy.sh`) sequence:**
1. Resolve the target (`dev` → namespace `aegispulse-dev`, overlay `dev`, token `AEGIS_DEPLOY_SA_TOKEN_DEV`; `prod` → `aegispulse`, overlay `prod`, `AEGIS_DEPLOY_SA_TOKEN_PROD`) and configure kubectl (namespace-scoped; cluster standard §3.5).
2. `cosign verify --key $COSIGN_PUBLIC_KEY` every image digest; abort on failure.
3. `kustomize edit set image` with `@sha256:` digests in `deploy/k8s/overlays/{dev|prod}`.
4. Apply `InfisicalSecret` CRs + ConfigMaps; wait for Secrets to exist.
5. Run `aegispulse-topology` Job (RabbitMQ assert), then migration Jobs (`aegispulse-migrate-{svc}-{sha}`) sequentially; wait `kubectl wait --for=condition=complete --timeout=300s`; abort on failure (no app rollout).
6. `kubectl apply -k` overlay; `kubectl rollout status` each Deployment (timeout 300 s); on failure run `ci/rollback.sh` automatically for app Deployments (migrations are backward-compatible by NFR-13).
7. Record deployed digests to `deploy/releases/{env}/{sha}.json` artifact (used by rollback and by the prod promotion check).

**Migration workflow:** Migrations are authored with the feature (`services/{svc}/db/migrations/V{n}__*.sql`), reviewed under the MR checklist (expand/contract, no edits to existing files — enforced by `ci/check-migrations.sh` comparing against `main`), executed in CI integration tests via Testcontainers, and applied in dev first, then in prod, only by the pre-rollout Jobs (a migration reaches prod only after passing in dev). Mongo index migrations follow the same flow with `migrate-mongo`.

**Pipeline secrets (GitLab CI/CD variables, Protected + Masked):** `AEGIS_DEPLOY_SA_TOKEN_DEV`, `AEGIS_DEPLOY_SA_TOKEN_PROD` (scoped to environment `prod`), `K8S_API_SERVER`, `COSIGN_PRIVATE_KEY` (file), `COSIGN_PASSWORD`, `COSIGN_PUBLIC_KEY`, `SONAR_TOKEN`, `SONAR_HOST_URL`, `ZAP_AUTH_CLIENT_ID`/`ZAP_AUTH_CLIENT_SECRET` (dev DAST service account; active scans never target prod), `NTFY_TOKEN` (pipeline failure notifications). Registry auth uses the built-in `$CI_REGISTRY_*` variables.

### 9.3 Cluster Bootstrap (one-time, replaces Terraform remote-state bootstrap)

Scripted in `deploy/bootstrap/*.sh`; each script is idempotent and re-read before running (cluster lesson §3.1). Every step needs credentials the repo and the AI agent never hold, so each is a **🛑 MANUAL** step in the [manual bootstrap register](docs/runbooks/manual-bootstrap.md): the agent prepares scripts/manifests, stops, and directs the operator; the operator reports back names and "done", never secret values.
1. 🛑 MANUAL (MB-07) `kubectl create namespace aegispulse` and `kubectl create namespace aegispulse-dev`; apply each namespace's `ResourceQuota`, `LimitRange`, and default-deny NetworkPolicy.
2. 🛑 MANUAL (MB-07) Create `aegispulse-ci-deployer` ServiceAccount + Role + RoleBinding **in each namespace**; mint one token per namespace; store as `AEGIS_DEPLOY_SA_TOKEN_DEV` / `AEGIS_DEPLOY_SA_TOKEN_PROD` (prod scoped to the protected `prod` GitLab environment).
3. 🛑 MANUAL (MB-01, **done**) Node roles (ADR-0015): run `deploy/bootstrap/10-storage-node-disk.sh` **on** `optiplex-tower` (formats/mounts the 1 TB data SSD at `/mnt/data`, bind-mounts it over the local-path directory, makes `k3s-agent` require the mount; the wipe step needs typed confirmation), then `deploy/bootstrap/20-node-roles.sh` from the workstation (storage labels + taint → `optiplex-tower`; `optiplex` → `node-role.kubernetes.io/worker=true`). Verify with `CHECK_ONLY=1 deploy/bootstrap/20-node-roles.sh`.
4. 🛑 MANUAL (MB-03…MB-06, MB-08; [runbook](docs/runbooks/infisical.md)) Infisical: project **AegisPulse** exists with environments Development/Production (confirm slugs); install the Infisical Kubernetes Operator (Helm, cluster-wide — not installed as of 2026-11-23); seed folders + generated secrets from `deploy/infisical/secrets-catalog.yaml` with `scripts/infisical/seed.py` (operator-run, `svc_admin`); create `aegispulse-operator-dev`/`-prod` identities, read-only per environment, Kubernetes Auth bound to each namespace's operator ServiceAccount.
5. 🛑 MANUAL (MB-09) RabbitMQ: create vhosts `aegispulse-dev` and `aegispulse-prod`, users per service per vhost (§5.7.3, suffix `-dev` for dev users), `aegis_topology` user, policies (DLQ max-length), enable `rabbitmq_prometheus` if not enabled.
6. 🛑 MANUAL (MB-11) Cloudflare: add public hostnames `aegispulse`, `aegispulse-api`, `aegispulse-objects` under **both** `rmwhs.com` (prod) and `rmwhs-dev.space` (dev) to the existing tunnel → `ingress-nginx`; WAF rules (§5.9) on both zones.
7. 🛑 MANUAL (MB-10) OpenObserve: create org/streams, ingestion token (stored in Infisical), import dashboards/alerts from `deploy/observability/`.
8. 🛑 MANUAL (MB-12) GitLab: protect `main` and `v*` tags, require MR approvals + passing pipeline; create environments `dev` and `prod` (`prod` **protected**, deploy requires maintainer approval); set CI variables (§9.2) with environment scopes; add a nightly pipeline schedule for `env:sleep:dev`.
9. 🛑 MANUAL (MB-13) Generate cosign key pair (`cosign generate-key-pair`), store private key + password in GitLab variables, commit public key to `deploy/cosign.pub`.

### 9.4 Tooling & Module Assessment

| Option considered | Decision |
|---|---|
| Helm umbrella chart vs. Kustomize | **Kustomize** (plain manifests + overlays). Cluster convention prefers plain manifests for owned apps; two overlays don't justify templating (ADR-0006). Third-party components (Infisical Operator, Uptime Kuma) use their official Helm charts. |
| Bitnami charts/images for datastores | **Rejected** — licensing/distribution changes make them unreliable; use official upstream images with project-owned StatefulSets. |
| CloudNativePG / MongoDB operators | Deferred — adds operators to a resource-constrained cluster; reconsider if HA is needed. |
| Argo CD (GitOps) | Deferred — pipeline-driven deploy with drift detection job is sufficient for one environment. |
| SonarQube self-hosted vs. SonarCloud | **SonarQube Community Build** in namespace `sonarqube` (~2 GiB limit) if capacity allows; fallback SonarCloud (requires mirroring/connecting the repo — open decision, see Appendix A). |
| Terraform | Only for Cloudflare DNS/tunnel config (optional) and documentation-grade AWS reference; no cluster objects. |
| Kaniko | Current cluster standard; upstream archived → evaluate Chainguard-maintained kaniko or buildah in Phase 10 (no privileged builds either way). |

### 9.5 Build & Task Commands (`Makefile`)

| Command | Effect |
|---|---|
| `make bootstrap` | install toolchains (pnpm, uv, Gradle wrapper), git hooks (gitleaks pre-commit) |
| `make env` | generate a local-only `.env` with random secrets (`scripts/dev/gen-local-secrets.sh`, incl. the derived OTLP header); never pulls from Infisical |
| `make up` / `make down` / `make reset` | start / stop / wipe local compose stack |
| `make migrate` | run Flyway for all schemas + Mongo migrations + topology assert (local) |
| `make seed` | seed tenants, users, entities, watchlists, sources, connectors (via the gateway API as the bootstrap PLATFORM_ADMIN; Phase 3 seeds tenants/entities/watchlists, later phases add the rest) |
| `make dev SERVICE=<name>` | run one service natively with hot reload against compose deps |
| `make build` | build all workspaces (tsc/vite, Gradle, uv build) |
| `make test` / `make test-unit` / `make test-integration` / `make test-e2e` | test suites (`test-e2e`: `tests/e2e` + `tests/security` against the running compose stack through the gateway, from Phase 2) |
| `make lint` / `make typecheck` / `make format` | quality |
| `make contracts` | validate + regenerate contract types (`packages/contracts/generated`) |
| `make eval` | golden-dataset evaluation |
| `make images` | local docker build of all images |
| `make demo` / `make chaos SCENARIO=<name>` | demo + chaos scripts |
| `make k3d-up` / `make k3d-down` | optional parity cluster |
| `make trigger JOB=<job>` | run a scheduler-trigger job locally |
| `make env-sleep ENV=dev` / `make env-wake ENV=dev` | scale the dev namespace to zero / back (prod is refused) |
| `make env-reset ENV=dev` | wipe and reseed dev data (prod is refused) |

### 9.6 Release, Versioning & Rollback
- SemVer tags `vMAJOR.MINOR.PATCH` for the platform; every MR adds a line under `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog). Release job moves Unreleased to the tag section.
- Promotion: dev → prod promotes identical digests (no rebuild); prod deploys are manual or tag-driven only.
- Rollback: `ci/rollback.sh <env> <previous-sha>` re-applies the digest set from `deploy/releases/{env}/{sha}.json`; database migrations are never rolled back (forward-fix only).
- Rollback drill once per phase from Phase 10 onward (evidence in `docs/evidence/`).

### 9.7 Monitoring & Alerting Configuration
- **OpenObserve alerts** (as code in `deploy/observability/alerts/*.json`): DLQ spike (FR-MSG-04), outbox lag > 60 s/5 min, consumer error rate > 5%/5 min, webhook rejection rate > 20%/10 min, p95 API latency > 500 ms/10 min, archive write failures > 0/5 min, audit chain failure (log match), pod restarts > 3/15 min → ntfy webhook (prod alerts → `aegispulse-alerts`; dev alerts → `aegispulse-alerts-dev`, low priority).
- **Uptime Kuma monitors**: prod `https://aegispulse-api.rmwhs.com/livez` (60 s) and dev `https://aegispulse-api.rmwhs-dev.space/livez` (5 min, paused while dev sleeps), `/readyz` via internal URL, console root, objects host TLS expiry (via Cloudflare), webhook health `POST /webhooks/_health-probe` (signed probe source, expects 202 duplicate), keyword monitor on `/healthz` JSON (`"status":"ok"`). Prod monitors notify `aegispulse-alerts`; dev monitors notify `aegispulse-alerts-dev`.
- **Dashboards**: Pipeline Overview (ingress rate, latency, rejections), Messaging (queue depth, consumer lag, retries, DLQ), Classification (stage mix, disagreement, overrides), Cases (opened/escalated/resolved, policy outcomes), Platform (CPU/mem per pod vs limits, OOMs, restarts).

---

## 10. Local Development

### 10.1 Prerequisites
- Docker Engine / Docker Desktop with Compose v2 (≥ 12 GiB RAM allocated recommended)
- Node.js 24 LTS + pnpm 12 (via Corepack, installed by `make bootstrap`), Java 25 (Temurin or Homebrew `openjdk@25`), Python 3.13 + uv, `gitleaks`, `shellcheck` (exact pins: `docs/steering/tech.md`)
- `make`, `jq`, `curl`, `openssl`
- Infisical CLI (to export local secrets), optional `k3d`, `kubectl`, `kustomize`, `cosign`, `k6`
- Optional: `gitleaks` (installed by `make bootstrap` as a pre-commit hook)

### 10.2 Starting the Stack
```bash
make bootstrap                       # toolchains + hooks (once)
make env                             # generates a local-only .env (random values; never real secrets)
make up                              # docker compose up -d (infra + services)
make migrate                         # flyway (5 schemas) + migrate-mongo + rabbitmq topology
make seed                            # demo tenants, users, entities, watchlists, sources
make demo                            # optional end-to-end scenario
open http://localhost:5173           # console (admin@acme.test / see seed output)
```

### 10.3 docker-compose.yml (summary)
```yaml
# deploy/compose/docker-compose.yml
name: aegispulse
x-svc-env: &svc-env
  env_file: ../../.env
  environment:
    OTEL_EXPORTER_OTLP_ENDPOINT: http://openobserve:5080/api/default
    AEGIS_ENV: local
services:
  # Infra (implemented in Phase 0; see the actual file for healthchecks and mem_limits)
  config-render:     { image: alpine:3.24.4 }                         # renders redis.conf + SeaweedFS s3.json from .env secrets
  postgres:          { image: postgres:18.7-alpine, ports: ["5432:5432"] }   # init: schemas + mig_*/svc_* roles + backup_reader
  mongo:             { image: mongo:8.0.38, ports: ["27017:27017"] }  # keyFile + replSet rs0 (healthcheck initiates); svc_events, backup users
  redis:             { image: redis:8.10.3-alpine, ports: ["6379:6379"] }   # ACL users per owning service; default user off
  rabbitmq:          { image: rabbitmq:4.4.1-management-alpine, ports: ["5672:5672", "15672:15672"] }
  rabbitmq-init:     { image: curlimages/curl:8.23.0 }                # vhost aegispulse-local, aegis_topology, svc_* users + permissions
  objectstore:       { image: chrislusf/seaweedfs:4.54, ports: ["9000:8333"] }   # ADR-0011
  objectstore-init:  { image: python:3.13-alpine }                    # buckets aegispulse-local-*, versioning on raw/backups
  clamav:            { image: clamav/clamav:1.5.5-debian13-slim, ports: ["3310:3310"] }
  openobserve:       { image: openobserve/openobserve:v1.1.2, ports: ["5080:5080"] }   # distroless; health probed from host
  # Readiness: `make up` = `compose up -d` + scripts/dev/compose-wait.sh (services healthy, one-shot init jobs exit 0)
  # Application runtimes (added in Phase 1):
  migrate:      { build: { context: ../.., dockerfile: deploy/docker/migrate.Dockerfile }, profiles: [tools], <<: *svc-env }
  gateway:            { build: { context: ../.., dockerfile: gateway/nest-http/Dockerfile }, ports: ["8080:8080"], <<: *svc-env }
  ingestion:          { build: ../../services/ingestion,           ports: ["8081:8081"], <<: *svc-env }
  files:              { build: ../../services/files,               ports: ["8082:8082"], <<: *svc-env }
  events:             { build: ../../services/events,              ports: ["8083:8083"], <<: *svc-env }
  registry:           { build: ../../services/registry,            ports: ["8084:8084"], <<: *svc-env }
  cases:              { build: ../../services/cases,               ports: ["8085:8085"], <<: *svc-env }
  risk-scoring:       { build: ../../services/risk-scoring,        ports: ["8086:8086"], <<: *svc-env }
  sensitivity-scanner:{ build: ../../services/sensitivity-scanner, ports: ["8087:8087"], <<: *svc-env }
  doc-extraction:     { build: ../../services/doc-extraction,      ports: ["8088:8088"], <<: *svc-env }
  data-intel:         { build: ../../services/data-intel,          ports: ["8089:8089"], <<: *svc-env }
  orchestrator:       { build: ../../services/orchestrator,        ports: ["8090:8090"], <<: *svc-env }
  console:            { build: ../../apps/console, ports: ["5173:8080"] }
volumes: { pgdata: {}, mongodata: {}, objdata: {} }
```
Every service declares `depends_on` with `condition: service_healthy` for its own datastores only; services still implement their own dependency retry (NFR-11).

### 10.4 Environment Variables (`.env.example`)
```dotenv
# ── global ────────────────────────────────────────────────────────────
AEGIS_ENV=local                                   # local | dev | prod
LOG_LEVEL=info
OTEL_SERVICE_NAMESPACE=aegispulse
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <local-openobserve-token>   # [secret]
PUBLIC_CONSOLE_URL=http://localhost:5173
PUBLIC_API_URL=http://localhost:8080
PUBLIC_OBJECTS_URL=http://localhost:9000          # host used in presigned URLs

# ── auth (registry) ───────────────────────────────────────────────────
REGISTRY_URL=http://registry:8084
JWT_ISSUER=aegispulse-registry
JWT_AUDIENCE=aegispulse                            # aegispulse-dev in dev, aegispulse in prod
JWT_SIGNING_KEY_CURRENT_PEM=<pem>                  # [secret] Infisical (dev/prod envs)
JWT_SIGNING_KEY_CURRENT_KID=local-2026-11
JWT_SIGNING_KEY_PREVIOUS_PEM=                      # [secret] operator's rollback copy during a rotation window; not read by registry (JWKS comes from registry.signing_keys)
SERVICE_CLIENT_ID=svc-<runtime>                    # per runtime
SERVICE_CLIENT_SECRET=<secret>                     # [secret] per runtime
PLATFORM_ADMIN_BOOTSTRAP_EMAIL=admin@aegispulse.local  # registry bootstrap command only (FR-TEN-09)
PLATFORM_ADMIN_BOOTSTRAP_PASSWORD=<secret>         # [secret] registry bootstrap command only; must satisfy FR-TEN-04 policy
SERVICE_CLIENT_SECRET_{RUNTIME}=<secret>           # [secret] registry only, one per §5.7.4 runtime (GATEWAY, INGESTION, FILES, EVENTS, ORCHESTRATOR, DOC_EXTRACTION, RISK_SCORING, DATA_INTEL, SCHEDULER_TRIGGER); Infisical references (ADR-0017)

# ── postgres (per owning service) ─────────────────────────────────────
PG_HOST=postgres
PG_PORT=5432
PG_DATABASE=aegispulse
PG_USER=svc_<schema>                               # svc_ingestion | svc_files | svc_registry | svc_cases | svc_analytics
PG_PASSWORD=<secret>                               # [secret]
FLYWAY_USER=mig_<schema>                           # migration Jobs only
FLYWAY_PASSWORD=<secret>                           # [secret]

# ── mongo (events only) ───────────────────────────────────────────────
MONGO_URI=mongodb://svc_events:<secret>@mongo:27017/aegispulse_events?replicaSet=rs0   # [secret]

# ── redis (ingestion, files, registry, risk-scoring) ──────────────────
REDIS_URL=redis://<acl-user>:<secret>@redis:6379/0  # [secret]

# ── rabbitmq ──────────────────────────────────────────────────────────
AMQP_URL=amqp://svc_<runtime>:<secret>@rabbitmq:5672/aegispulse-local   # [secret]
AMQP_PREFETCH_DEFAULT=10

# ── object store ──────────────────────────────────────────────────────
S3_ENDPOINT=http://objectstore:9000
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=true
S3_ACCESS_KEY_ID=<per-service>                     # [secret]
S3_SECRET_ACCESS_KEY=<per-service>                 # [secret]
S3_BUCKET_PREFIX=aegispulse-local

# ── ingestion ─────────────────────────────────────────────────────────
INGESTION_KEK_BASE64=<32-byte key>                 # [secret] wraps webhook secret data keys
INGESTION_KEK_VERSION=1
WEBHOOK_MAX_SKEW_SECONDS=300
WEBHOOK_NONCE_TTL_SECONDS=900
CONNECTOR_FETCH_TIMEOUT_MS=10000

# ── files ─────────────────────────────────────────────────────────────
FILES_MAX_SINGLE_PUT_BYTES=67108864
FILES_AV_ENABLED=true
CLAMAV_HOST=clamav
MULTIPART_UPLOADS_ENABLED=false

# ── scoring / scanner / extraction ────────────────────────────────────
RISK_MODEL=heuristic                               # heuristic | iforest
HIGH_RISK_COUNTRIES_DEFAULT=IR,KP,SY,CU,RU         # illustrative default list, tenant-overridable
SCANNER_URL=http://sensitivity-scanner:8087
SCANNER_LLM_ENABLED=false
SCANNER_LLM_MODEL=claude-haiku-5-5
ANTHROPIC_API_KEY=                                 # [secret] only if SCANNER_LLM_ENABLED
SCANNER_LLM_MONTHLY_BUDGET_USD=5
EXTRACTION_CONFIDENCE_THRESHOLD=0.70

# ── notifications ─────────────────────────────────────────────────────
NTFY_URL=https://ntfy.example.invalid               # set per env
NTFY_TOPIC=aegispulse-alerts-local                # aegispulse-alerts-dev (dev), aegispulse-alerts (prod)
NTFY_TOKEN=<secret>                                 # [secret]

# ── demo ──────────────────────────────────────────────────────────────
DEMO_MODE_ALLOWED=true
```
Local values are generated by `make env` (`scripts/dev/gen-local-secrets.sh`) and never come from Infisical, so a laptop never holds dev or prod secrets (NFR-06). In dev and prod every `[secret]` value is synced from the matching Infisical environment by the Operator into `aegispulse-{component}-secrets`; non-secret values live in ConfigMaps.

### 10.5 Testing the Async Flow Locally
```bash
API=http://localhost:8080
# 1) Login
TOKEN=$(curl -s $API/v1/auth/login -H 'content-type: application/json' \
  -d '{"tenantSlug":"tenant-acme-capital","email":"analyst@acme.test","password":"<seeded>"}' | jq -r .data.accessToken)

# 2) Signed webhook (helper prints headers + body)
pnpm tsx scripts/demo/webhook-sign.ts --source acme-sec-relay --secret "$ACME_SOURCE_SECRET" \
  --file eval/golden/webhooks/acquisition-globex.json | sh     # emits a curl to /webhooks/acme-sec-relay
#    → 202 {"data":{"deliveryId":"…","eventId":"…","duplicate":false}}
#    re-run the same command → 409 WEBHOOK_REPLAY_DETECTED (same delivery id)

# 3) Transaction that crosses the case threshold
curl -s $API/v1/transactions -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "idempotencyKey":"demo-txn-0001","accountId":"ACC-100","counterpartyId":"CP-GLBX","counterpartyName":"Globex Clearing",
  "amount":"125000.00","currency":"USD","country":"KY","channel":"WIRE","occurredAt":"2026-11-22T10:00:00Z","metadata":{}}'

# 4) Upload a filing
SHA=$(shasum -a 256 eval/golden/filings/acme-10q.pdf | cut -d' ' -f1)
INIT=$(curl -s $API/v1/files/uploads/init -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"filename\":\"acme-10q.pdf\",\"contentType\":\"application/pdf\",\"sizeBytes\":$(stat -f%z eval/golden/filings/acme-10q.pdf),\"sha256\":\"$SHA\",\"purpose\":\"FILING\"}")
curl -s -X PUT "$(echo $INIT | jq -r .data.uploadUrl)" -H 'content-type: application/pdf' --data-binary @eval/golden/filings/acme-10q.pdf
curl -s -X POST $API/v1/files/uploads/$(echo $INIT | jq -r .data.fileId)/complete -H "authorization: Bearer $TOKEN"

# 5) Watch the pipeline
curl -N $API/v1/stream -H "authorization: Bearer $TOKEN"
curl -s "$API/v1/cases?status=ESCALATED" -H "authorization: Bearer $TOKEN" | jq
curl -s "$API/v1/events?correlationId=<corr-id>" -H "authorization: Bearer $TOKEN" | jq '.data[].classification'
```


---

## 11. Implementation Plan

### 11.0 Completion Gate, Evidence & Status Ledger

**Status vocabulary** (per FR and per phase): `PENDING` → `SCAFFOLDED` (route/file shells) → `SOURCE-IMPLEMENTED` → `MIGRATION-ADDED` → `UNIT-VERIFIED` → `INTEGRATION-VERIFIED` (real Postgres/Mongo/Redis/RabbitMQ/object store via Testcontainers or compose) → `RUNTIME-VERIFIED` (running entrypoints in compose **and** dev, promoted to prod with smoke passing, exercised over HTTP/broker, evidence attached). Never mark a spec `[x]` because files or route shells exist.

**Runtime Completion Gate** — a phase is complete only when all apply:
1. Source + migrations merged to `main`; contracts regenerated with no diff.
2. Runnable entrypoints start from clean state (`make reset && make up && make migrate`), pass `/readyz`; from Phase 9 on, also deployed to dev and passing `/readyz` there.
3. Real dependencies used (no mocks) in integration and E2E suites for every FR in the phase.
4. Async behavior verified: outbox publication, consumer idempotency under 3× redelivery, retry → DLQ path.
5. Security checks for the phase pass (authz matrix, cross-tenant, input limits, secret handling).
6. Operations: logs/traces/metrics visible in OpenObserve for the phase's flows; alerts defined where §9.7 requires.
7. UI/client items (if any) exercised by Playwright.
8. From Phase 9 on: dev verification green and the same digests promoted to prod with prod smoke passing.
9. Phase exit evidence committed to `docs/evidence/phase-{NN}.md` using the template (commands, outputs, endpoints exercised, environment, commit SHA, date, artifact links).

**Status ledger** (update in the same MR that changes status; mirrored in `CHANGELOG.md`):

| Phase | Name | Status | Evidence |
|---|---|---|---|
| 0 | Project Scaffold & Toolchain | COMPLETE (gate met: pipelines green, clean-state run, merged to `main` in !1 (`46ccd5e`, 2026-11-24)); carried to Phase 9: `make up` on Linux | [phase-00](docs/evidence/phase-00.md), [clean-state](docs/evidence/clean-state-2026-11-24.md) |
| 1 | Contracts, Platform Kits & Data Foundations | COMPLETE (gate met: slices 1a–1e, 12 runtimes `/readyz`, OpenObserve traces + metrics, pipelines green, clean-state run, merged to `main` in !1 (`46ccd5e`, 2026-11-24)) | [phase-01a](docs/evidence/phase-01a.md), [phase-01b](docs/evidence/phase-01b.md), [phase-01c](docs/evidence/phase-01c.md), [phase-01d](docs/evidence/phase-01d.md), [phase-01e](docs/evidence/phase-01e.md), [clean-state](docs/evidence/clean-state-2026-11-24.md) |
| 2 | Registry: Tenancy, Identity & RBAC | COMPLETE (gate met: 2a–2c, local JWKS drill, pipelines green, clean-state run, merged to `main` in !1 (`46ccd5e`, 2026-11-24)); carried to Phase 9: dev JWKS drill, MB-15 | [phase-02a](docs/evidence/phase-02a.md), [phase-02b](docs/evidence/phase-02b.md), [phase-02c](docs/evidence/phase-02c.md), [clean-state](docs/evidence/clean-state-2026-11-24.md) |
| 3 | Entities & Watchlists | COMPLETE (gate met: pipelines green, clean-state run, merged to `main` in !1 (`46ccd5e`, 2026-11-24)) | [phase-03](docs/evidence/phase-03.md), [clean-state](docs/evidence/clean-state-2026-11-24.md) |
| 4 | Webhook Ingestion | COMPLETE (gate met: exit items, pipelines green, clean-state run, merged to `main` in !1 (`46ccd5e`, 2026-11-24)) | [phase-04](docs/evidence/phase-04.md) ([4a](docs/evidence/phase-04a.md), [4b](docs/evidence/phase-04b.md), [4c](docs/evidence/phase-04c.md)), [clean-state](docs/evidence/clean-state-2026-11-24.md) |
| 5 | Files Subsystem | COMPLETE (gate met: exit items, OpenObserve, pipelines green, clean-state run, merged to `main` in !1 (`46ccd5e`, 2026-11-24)) | [phase-05](docs/evidence/phase-05.md) ([5a](docs/evidence/phase-05a.md), [5b](docs/evidence/phase-05b.md), [5c](docs/evidence/phase-05c.md), [5d](docs/evidence/phase-05d.md), [5e](docs/evidence/phase-05e.md)), [clean-state](docs/evidence/clean-state-2026-11-24.md) |
| 6 | Events Archive & Stage-1 Classification | COMPLETE (gate met: exit items, OpenObserve, pipelines green, clean-state run, merged to `main` in !1 (`46ccd5e`, 2026-11-24)) | [phase-06](docs/evidence/phase-06.md) ([6a](docs/evidence/phase-06a.md), [6b](docs/evidence/phase-06b.md), [6c+6d](docs/evidence/phase-06c.md)), [clean-state](docs/evidence/clean-state-2026-11-24.md) |
| 7 | Messaging Resilience & Dead Letters | IN PROGRESS (exit items met locally; open: pipelines, merge, clean-state run; FR-MSG-04 dev alert test → Phase 18) | [phase-07](docs/evidence/phase-07.md) |
| 8 | Transactions, Scoring & Risk Cases (MVP slice) | IN PROGRESS (8a runtime-verified; 8b integration-verified) | [phase-08a](docs/evidence/phase-08a.md), [phase-08b](docs/evidence/phase-08b.md) |
| 9 | Kubernetes, IaC & Secrets (homelab dev + prod) | PENDING | — |
| 10 | CI/CD & DevSecOps Gates | PENDING | — |
| 11 | Document ETL & Extraction | PENDING | — |
| 12 | AI Scanner, Stage-2 Classification & ML Scoring | PENDING | — |
| 13 | Connectors | PENDING | — |
| 14 | Cross-Domain Correlation & Notifications | PENDING | — |
| 15 | Replay & Cold Tier | PENDING | — |
| 16 | Data Intelligence & Evaluation | PENDING | — |
| 17 | Gateway Completion & SSE | PENDING | — |
| 18 | Observability, Synthetic Monitoring & Chaos | PENDING | — |
| 19 | Analyst Console | PENDING | — |
| 20 | Portfolio Demo & Evidence Pack | PENDING | — |

Mapping to the source roadmap ([docs/AEGIS_PULSE.md §8](docs/AEGIS_PULSE.md)): source Phase 1 ≈ Phases 0–10; source Phase 2 ≈ Phases 11–14; source Phase 3 ≈ Phases 15–16; source Phase 4 ≈ Phases 17–18 (with 9–10 delivering its secrets/CI foundations early). Phases 19–20 deliver the portfolio checklist (§9 of the source).

---

### Phase 0 — Project Scaffold & Toolchain

**Goal:** a repository that builds, lints, tests (empty suites), starts local infrastructure, and enforces guardrails from the first commit.

#### Workstream: Repository & guardrails
- [x] Monorepo workspace definitions per §6.1: `pnpm-workspace.yaml`, Gradle multi-project `settings.gradle.kts` (includes Java projects once their directories exist), uv workspace root `pyproject.toml`. Member packages are created with the service skeletons in Phase 1.
- [x] `Makefile` targets from §9.5. Targets for later phases exit 2 with "delivered in Phase N", so they never fake success. `env-sleep`/`env-wake`/`env-reset` refuse `ENV=prod`.
- [x] `.editorconfig`, `.gitignore` (`.env*` except `.env.example`, keys, `.tools/`, build outputs), `.nvmrc` (24.22.3), `.python-version` (3.13), Gradle Java 25 toolchain convention
- [x] ESLint 10 (flat, typescript-eslint strict, `no-explicit-any: error`) / Prettier, Ruff / mypy `--strict` configs (NFR-14)
- [x] Spotless / Error Prone / ArchUnit. Delivered in Phase 1 with the first Java project: Error Prone + NullAway and Spotless in `build.gradle.kts` (`ci/lint-java.sh` runs `spotlessCheck`), ArchUnit rules in `java-platform` (`AegisArchitectureRulesTest`)
- [x] `ci/check-boundaries.sh` (NFR-09, ADR-0013), `ci/check-migrations.sh`, `ci/check-resource-budget.sh` (+ `ci/lib/resource_budget.py`) with self-tests (`ci/tests/run.sh`, 10 cases)
- [x] `ci/check-layer-sizes.sh`: self-tested in `ci/tests/run.sh` (FROM-scratch images: a small layer passes, a 96 MB incompressible layer fails; skipped without a Docker daemon) — 2026-11-24
- [x] Gitleaks pre-commit hook (`.githooks/pre-commit`, enabled by `make bootstrap`); `.gitleaks.toml` allowlists `tests/fixtures/secrets-synthetic/` only
- [x] `CLAUDE.md`, `AGENTS.md`, `.claude/` (skills, agents with model routing, hooks), `docs/steering/`, `docs/adr/0001–0014`, `docs/specs/_template.md`, `docs/evidence/_template.md`, `CHANGELOG.md`
- [x] Exact versions pinned after verifying current releases (`docs/steering/tech.md`); TS 7 deferred with rationale; ADR-0011 decided (SeaweedFS 4.54, 10/10 compatibility checks)

#### Workstream: Local infrastructure
- [x] `deploy/compose/docker-compose.yml` infra services (postgres, mongo rs0 + keyFile, redis, rabbitmq + init, objectstore + init, clamav, openobserve, config-render) with healthchecks. OpenObserve is probed from the host because its image is distroless.
- [x] Init: `init/postgres/01-roles-schemas.sh` (5 schemas, `mig_*`/`svc_*`, default privileges, `backup_reader`), `init/mongo/01-users.js`, `init/redis/redis.conf.tmpl` (ACL per owner), `init/rabbitmq/init.sh` (vhost, topology user, least-privilege `svc_*`), `init/objectstore/{s3.json.tmpl,buckets.py}`. The Phase 0 plan named `definitions.json`/`buckets.sh`; replaced by API-driven init so passwords are never hashed into committed files.
- [x] `.env.example` (Section A generated secrets, Section B per-runtime variables) + `scripts/dev/gen-local-secrets.sh` + `make env`
- [x] `make up` / `make down` / `make reset` verified on macOS (Docker 29.4.3, arm64). Isolation probes pass: cross-schema denial, DDL denial for `svc_*`, Mongo DB scoping, Redis key-prefix ACLs, RabbitMQ permissions, prefix-scoped S3.
- [ ] `make up` verified on Linux. Pending: the CI pipeline runs lint/test/contract only (no compose), so this moves to the Phase 9 homelab runs.

#### Workstream: CI skeleton
- [x] `.gitlab-ci.yml` with `.pre` (gitleaks), `lint` (shell, node, python, java, guardrails), `test` stages calling `ci/*.sh`; every job image tag verified to exist
- [x] First green GitLab pipeline (owner-reported 2026-11-24: pipelines green for the pushed `feature/project` commits through `7e2c8d8`)
- [x] Merge request template with checklist: FR ids, spec link, migrations expand/contract, contract diff, CHANGELOG entry, evidence

**Phase 0 exit evidence:** [docs/evidence/phase-00.md](docs/evidence/phase-00.md), with `make bootstrap`, `make lint`, `make test`, `make up`, isolation probes, and ADR-0011 compatibility output. The first green GitLab pipeline URL + SHA is still pending.
**Phase note:** status **`COMPLETE`** (2026-11-24): Runtime Completion Gate met — pipelines green, clean-state run ([clean-state-2026-11-24](docs/evidence/clean-state-2026-11-24.md)), merged to `main` in !1. Carried to Phase 9: `make up` on Linux (CI has no compose stage).

---

### Phase 1 — Contracts, Platform Kits & Data Foundations

**Goal:** wire contracts and shared kits exist and are verified before any feature code.

#### Workstream: Contracts (`packages/contracts`)
- [x] `envelope/canonical-envelope.v1.schema.json` (§6.4) + valid/invalid examples; JSON Schema tests in all three languages. **TS (Vitest/Ajv), Python (pytest/jsonschema) and Java (JUnit/networknt, 1c) suites pass; `make contracts` also checks that valid envelope examples' payloads conform to their eventType schema (1c).**
- [x] `topology/aegispulse.topology.json` (§5.5, §6.5) + `topology-assert` CLI (Node) used by `make migrate` (the K8s Job wrapper is a Phase 9 item). 6 exchanges / 58 queues / 71 bindings; integration-tested on RabbitMQ 4 (idempotent re-assert, routing, DLX fan-in, drift rejection)
- [x] `asyncapi/aegispulse.asyncapi.yaml` covering every routing key in §6.7 with payload schemas in `events/` (38 keys, 38 schemas + examples; parser-valid)
- [x] `openapi/gateway.public.yaml` (79 operations, §8) and 8 `{service}.internal.yaml` files with every HTTP-invoked §6.2 `operationId` (103) + `x-aegis-consumer-actions`; Redocly lint clean
- [x] Code generation (`make contracts`) → TS types, Java records, Pydantic models; CI fails on uncommitted diff. **TS (envelope, 38 events, 8 OpenAPI, topology unions), Pydantic v2 (42 modules) and Java records (55 types: envelope, 38 payloads, EventTypes, Topology; 1c) generated deterministically; `ci/contract.sh` drift gate in place.**
- [x] `service-actions.ts` union (§6.2) generated from internal OpenAPI operationIds and validated against PROJECT.md §6.2 by `make contracts` (115 ↔ 115)

#### Workstream: Platform kits (no business logic)
- [x] `ts-platform`: typed config loader (fail-fast, redacted errors), pino logger with mandatory fields + redaction, OTel bootstrap (HTTP + AMQP propagation), error/result types, undici HTTP client with timeouts/retries/breaker (opossum), JWT verifier (JWKS cache), health endpoints, graceful shutdown, idempotency helper, outbox repository + relay, AMQP consumer/publisher kit wrapping `rxjs-rabbitmq` with typed topology generics, confirms, retry/DLQ policy — `INTEGRATION-VERIFIED` 2026-11-23 ([phase-01b](docs/evidence/phase-01b.md))
- [x] `java-platform`: Spring Boot starter — JSON logging, OTel, resource-server config (JWKS), `act[]` authorization helper, outbox (JdbcClient) + relay, Spring AMQP consumer kit with retry/DLQ policy, `/livez` `/readyz` `/healthz`, Flyway version readiness check, ArchUnit rules — `INTEGRATION-VERIFIED` 2026-11-23 ([phase-01c](docs/evidence/phase-01c.md)); OTel via the Java agent is verified with the service skeletons (1e)
- [x] `py-platform`: Pydantic Settings, structlog JSON, OTel, JWT verifier, aio-pika consumer kit (retry/DLQ, dedup hook), FastAPI health router, graceful shutdown, import-linter contracts — `INTEGRATION-VERIFIED` 2026-11-23 ([phase-01d](docs/evidence/phase-01d.md)); also outbox (psycopg 3) for data-intel; the outbound HTTP client (httpx + pybreaker) lands with the first Python service that calls another (doc-extraction)
- [x] Each kit: unit tests + Testcontainers integration tests (RabbitMQ retry → DLQ path, outbox relay publish-with-confirm, consumer redelivery dedup) — ts-platform 48 unit + 20 integration ([phase-01b](docs/evidence/phase-01b.md)); java-platform 31 unit + 11 integration ([phase-01c](docs/evidence/phase-01c.md)); py-platform 33 unit + 11 integration ([phase-01d](docs/evidence/phase-01d.md))

#### Workstream: Data foundations
- [x] `V1__baseline.sql` per schema: `outbox_events`, `processed_messages` (files, cases, analytics), `idempotency_records` (ingestion, files, registry, cases; RLS), `set_updated_at()`, `current_tenant()`/`rls_bypassed()` RLS helpers (`rls_bypassed()` removed by V2, ADR-0016), `afterMigrate.sql` history-protection callback
- [x] Flyway runner image (`deploy/docker/migrate.Dockerfile`) + `make migrate` running all schemas with their `mig_*` users (idempotent re-run verified)
- [x] `migrate-mongo` project in `services/events` with `schema_meta`, collection validators, and §7.6 indexes (runs as `mig_events`; `svc_events` lacks `dbAdmin`)
- [x] Migration integration test: apply all migrations to empty PG18/Mongo8 containers; assert role grants (svc roles cannot touch other schemas, no DDL, history read-only, RLS fail-closed, backup read-only): 25/25. The `svc_cases`/`audit_log` assertion is added with the `audit_log` migration in Phase 8 (FR-AUD-01).
- [x] Enforced RLS bypass (ADR-0016): `V2__enforced_rls_bypass.sql` per schema drops `rls_bypassed()` and the policy bypass clause and adds `{schema}.purge_expired_idempotency_records()` (SECURITY DEFINER, owned by NOLOGIN BYPASSRLS `{schema}_platform` from the init script); migration test asserts the old setting is ignored, function ownership/grants, and no `SET ROLE` for `svc_*` (30/30)

#### Workstream: Service skeletons
- [x] Every runtime in §5.4 boots with config validation, `/livez`, `/readyz` (checking only its own deps), structured logs, and traces; Dockerfiles (multi-stage, non-root, read-only FS) — 12 runtimes (`make up` + `make migrate`: all `/readyz` = 200, [phase-01e](docs/evidence/phase-01e.md)); shared `deploy/docker/{node-service,java-service,python-service,console}.Dockerfile`; health-request traces verified in OpenObserve
- [x] `gateway/nest-http` skeleton: request id, correlation id, body limits, error envelope (§8.2), JWKS auth middleware, OpenAPI served at `/v1/openapi.json` — NestJS 12 on the platform Fastify instance; global JWKS guard with `@Public()` opt-out; [phase-01e](docs/evidence/phase-01e.md)

**Phase 1 exit evidence:** `make contracts` clean; kit integration tests output; `make up` with all 12 runtimes `/readyz` = 200; trace of a health request in OpenObserve.
**Phase note:** status **`COMPLETE`** (2026-11-24): Runtime Completion Gate met — pipelines green, clean-state run ([clean-state-2026-11-24](docs/evidence/clean-state-2026-11-24.md)), merged to `main` in !1.

---

### Phase 2 — Registry: Tenancy, Identity & RBAC

#### FR-TEN-01 / FR-TEN-02 / FR-TEN-03 — Tenant lifecycle
- [x] Migration `V3__tenants.sql` (`registry.tenants`, RLS exempt for platform table, indexes §7.1)
- [x] `TenantService.create/updateStatus/deactivate` with state rules (`DEACTIVATED` terminal), idempotency via `idempotency_records`
- [x] Internal API `createTenant`, `updateTenantStatus`; gateway handlers `POST /v1/tenants`, `PATCH /v1/tenants/{id}`
- [x] Outbox `registry.tenant.created|suspended|restored|deactivated`; PA-only authorization; audit consumed later by cases (Phase 8)
- [x] Tests: unit (state machine), integration (duplicate slug 409, idempotent retry), suspended tenant login → 403 (`AuthIT`, registry integration)

#### FR-TEN-04 / FR-TEN-05 — Users and roles
- [x] Migration `V4__users_roles.sql` (`users`, `user_roles`, RLS)
- [x] `UserService` create/list/update/disable with Argon2id hashing, password policy (length + zxcvbn-equivalent `nbvcxz`), last-admin invariant
- [x] Internal + gateway routes `GET/POST /v1/users`, `PATCH /v1/users/{id}`; pagination
- [x] Role change → refresh-token revocation + `registry.user.changed`
- [x] Tests: last-admin 409, email uniqueness per tenant (citext), cross-tenant 404

#### FR-TEN-06 / FR-TEN-07 — Service accounts
- [x] Migration `V5__service_accounts.sql` (`service_accounts`, `service_account_secrets`)
- [x] `ServiceAccountService` create/rotate (24 h grace)/revoke; internal SERVICE accounts seeded by `R__seed_service_accounts.sql` with `allowed_actions` (§5.7.4); secret verifiers reconciled at startup from `SERVICE_CLIENT_SECRET_{RUNTIME}` (ADR-0017)
- [x] Routes `/v1/service-accounts*`; secret displayed once
- [x] Tests: rotated secret valid for 24 h then rejected (clock-controlled test)

#### FR-TEN-09 — Platform bootstrap
- [x] `R__platform_tenant.sql` (reserved `platform` tenant, fixed id); API rejects creating/suspending slug `platform`
- [x] `bootstrap-platform-admin` command (Spring `ApplicationRunner` profile, run as Job / compose `tools` service): first `PLATFORM_ADMIN` from `PLATFORM_ADMIN_BOOTSTRAP_*`, idempotent, audited (compose `registry-bootstrap`; the k8s Job is Phase 9)
- [ ] 🛑 MANUAL (MB-15) dev/prod: set `PLATFORM_ADMIN_BOOTSTRAP_EMAIL` in Infisical `/registry`, re-run the seeder (generates the password), run the Job at first deploy, log in once and change the password
- [x] Tests: second run is a no-op; generated password passes FR-TEN-04 policy; PA can create a tenant and its first TENANT_ADMIN

#### FR-TEN-08 — Tenant settings
- [x] `getTenantSettings`/`updateTenantSettings` + `registry.tenant.settings_changed`; caller-side 60 s cache in kits (TS `TenantSettingsCache`, Python `aegis_platform.tenant_settings`)
- [x] Tests: settings change propagates to scoring threshold within 60 s (integration). Cache TTL/invalidation unit-tested in both kits; the end-to-end scoring propagation test needs risk-scoring, which is Phase 8, and is tracked there (FR-TXN-04 checklist)

#### FR-AUTH-01 / FR-AUTH-02 / FR-AUTH-03 / FR-AUTH-07 — User authentication
- [x] Migration `V6__auth.sql` (`refresh_tokens`, `signing_keys`)
- [x] `AuthService.login/refresh/logout/changePassword` with RS256 signing (Nimbus), refresh rotation families, reuse detection → family revoke + security audit event, Redis login rate limit
- [x] Gateway routes `/v1/auth/*`; uniform error messages; no user enumeration
- [x] Tests: refresh reuse revokes family; 6th failed login → 429; token claims match §2.2

#### FR-AUTH-04 / FR-AUTH-05 — Client credentials & JWKS
- [x] `/v1/auth/token` (INTEGRATION) and `issueClientCredentialsToken` (`POST /internal/v1/issueClientCredentialsToken`, unauthenticated; SERVICE, `aud=aegispulse-internal`, `act[]`)
- [x] `/.well-known/jwks.json` with current + previous keys; key rotation runbook `docs/runbooks/key-rotation.md`
- [x] Kits: JWKS cache refresh on unknown `kid`
- [ ] Tests: rotation drill — tokens signed by previous key accepted ≤ 24 h (integration ✅ `JwksIT`; local drill ✅ 2026-11-24 after the 5 s cooldown fix, [phase-02c](docs/evidence/phase-02c.md); environment drill on dev for the phase exit, Phase 9)

#### FR-AUTH-06 — Authorization enforcement
- [x] Authorization policy module in every service (role matrix §1.4.6 as data), tenant-ownership checks in service layer, `X-Aegis-Tenant` for PA with `actingAs` audit (registry `AccessPolicy`; gateway edge check from the generated contract route table; later services add theirs with their FRs)
- [x] Cross-tenant test harness (`tests/security/cross-tenant.spec.ts`) seeded with two tenants; grows with each phase
- [x] Tests: every Phase-2 route × every role matrix (generated table test): `AccessPolicyTest` (registry) + `tests/e2e/role-matrix.e2e.test.ts` (gateway, 13 routes × 6 roles)

**Phase 2 exit evidence:** E2E auth flows over the gateway (login, refresh, rotate, logout); cross-tenant suite green; JWKS rotation drill log.
**Phase note:** migrations are V3–V6 (V2 is ADR-0016's `enforced_rls_bypass`). Auth lookups that precede tenant context (refresh token by hash, service account by client id) are `SECURITY DEFINER` functions per ADR-0016. Delivered in slices: 2a tenants + users + platform bootstrap; 2b signing keys/JWKS, auth flows, service accounts, client credentials; 2c settings, gateway routes, role matrix, cross-tenant suite, E2E + rotation drill.
**Phase note:** status **`COMPLETE`** (2026-11-24): Runtime Completion Gate met — pipelines green, clean-state run ([clean-state-2026-11-24](docs/evidence/clean-state-2026-11-24.md)), merged to `main` in !1. History: Slice 2c (settings, gateway routes, role matrix, cross-tenant suite, E2E) is `RUNTIME-VERIFIED` locally (2026-11-23, [phase-02c](docs/evidence/phase-02c.md)): `make test-e2e` 85/85 over the gateway. JWKS rotation drill run 2026-11-24: mechanics verified, and its finding (a 30 s post-rotation 401 window) was fixed with a 5 s refetch cooldown; the confirming rerun passed the same day (`/me` 200 with the new kid right after rotation, and with a pre-rotation token). Exit items still open: the green pipeline and the dev-environment drill (Phase 9). The FR-TEN-08 scoring propagation test moved to Phase 8 (risk-scoring). Slice 2b (auth flows, JWKS, client credentials, service accounts; ADR-0017) is `INTEGRATION-VERIFIED` and runtime-verified locally (2026-11-23, [phase-02b](docs/evidence/phase-02b.md)): 29 unit + 29 Testcontainers tests; JVM heap rule amended to 50%. Slice 2a (tenants, users, platform bootstrap) is `INTEGRATION-VERIFIED` (2026-11-23, [phase-02a](docs/evidence/phase-02a.md)): 24 unit + 13 Testcontainers tests, migrations applied locally, registry `/readyz` 200 at schema 4. Local bootstrap runtime-verified (create, then no-op; event relayed `SENT`). `registry.tenant.deactivated` added by amendment (2026-11-23).

---

### Phase 3 — Entities & Watchlists

#### FR-ENT-01 / FR-ENT-02 — Entity management
- [x] Migration `V7__entities.sql` (`entities`, `entity_aliases`, `pg_trgm`, RLS)
- [x] `EntityService` create/get/list/update/archive with normalization function (shared, unit-tested with fixtures), alias management
- [x] Gateway routes `/v1/entities*`; search `q` via trigram
- [x] `registry.entity.changed` outbox event
- [x] Tests: normalization table test (suffix stripping), duplicate 409, archived entity excluded from matching

#### FR-ENT-03 — Entity resolution
- [x] `EntityResolutionService.resolve` (ticker exact → alias exact → normalized → trigram ≥ 0.85), deterministic ordering (in `EntityService.resolve`, batched per stage)
- [x] Internal route `resolveEntities` (SERVICE `act[]` allowlist)
- [x] Tests: golden mention→entity fixtures; p95 ≤ 50 ms for 50 mentions (integration timing: p95 11 ms)

#### FR-ENT-04 / FR-ENT-05 — Watchlists
- [x] Migration `V8__watchlists.sql`
- [x] `WatchlistService` CRUD + entries + pause; `checkWatchlists` (entityIds or counterparty refs via resolution)
- [x] Gateway routes `/v1/watchlists*`; `registry.watchlist.changed`
- [x] Tests: paused watchlist yields no hits; deleted entry stops matching

**Phase 3 exit evidence:** seeded demo entities/watchlists via API; resolution fixtures output; cross-tenant suite extended.
**Phase note:** migrations are V7/V8 (Phase 2 took V3–V6).
**Phase note:** status **`COMPLETE`** (2026-11-24): Runtime Completion Gate met — pipelines green, clean-state run ([clean-state-2026-11-24](docs/evidence/clean-state-2026-11-24.md)), merged to `main` in !1. History: `INTEGRATION-VERIFIED` and runtime-verified through the gateway (2026-11-24, [phase-03](docs/evidence/phase-03.md)). Registry 46 unit + 36 Testcontainers tests; `make test-e2e` 152/152 (role matrix 24 routes × 6 roles; cross-tenant suite extended). Demo seed via the API runtime-verified (idempotent, two runs). Open exit item: commit + green pipeline.

---

### Phase 4 — Webhook Ingestion

#### FR-WHK-01 / FR-WHK-07 — Webhook source management
- [x] Migration `V3__webhook_sources.sql` (`webhook_sources`, `webhook_secrets`, RLS)
- [x] `WebhookSourceService` register/list/update/rotate/delete; envelope encryption (AES-256-GCM, KEK from env) in `src/domain/crypto`; trust-level change emits `ops.audit.source_trust_changed`
- [x] Gateway routes `/v1/webhook-sources*`; secret returned once (deliveries listing with 4b)
- [x] Tests: encrypt/decrypt round-trip; rotation keeps previous for 72 h; KEK missing → startup fails

#### FR-WHK-02 / FR-WHK-03 — Signature verification & replay protection
- [x] `src/domain/signature.ts`: canonical signed string, constant-time compare (`crypto.timingSafeEqual` on equal-length buffers), multi-signature header parsing
- [x] `IngestWebhookUseCase`: source lookup → status/tenant checks → verify (current, previous) → skew → Redis nonce `SET NX` → schema validation
- [x] Gateway `WebhooksController` (`POST /webhooks/:sourceKey`): `req.rawBody` via `NestFactory.create(..., { rawBody: true })` (no JSON re-serialization before forwarding), 1 MiB route limit, passes headers + base64 body to `ingestWebhookDelivery` (clarification: a buffer content-type parser instead of `rawBody: true`; see spec)
- [x] Metrics `aegispulse_webhook_rejected_total{source,reason}`; logs without body
- [x] Tests: adversarial suite (FR-EVAL-04 subset): wrong secret, truncated signature, skew ±301 s, replayed delivery id, oversize, malformed JSON, missing headers → expected codes; timing test asserts constant-time path used

#### FR-WHK-04 / FR-WHK-05 — Canonical event creation & persistence
- [x] Migration `V4__webhook_deliveries.sql`
- [x] `EnvelopeBuilder` (domain): UUIDv7 eventId, correlation id, category → eventType map, classification seed (`publisher_stated_severity`, `UNCLASSIFIED`, `INGESTED`)
- [x] Raw body put to object store before TX; TX inserts delivery + outbox; duplicate idempotency key → `DUPLICATE` delivery row, no outbox
- [x] Outbox relay publishes to `aegispulse.ingress`
- [x] Tests: integration (compose) — accepted webhook appears on a test queue bound to `external.#` exactly once after 3 relay restarts; duplicate externalId → `duplicate:true`

#### FR-WHK-08 — Secret expiry & raw-object sweep
- [x] `expirePreviousSecrets` + orphan raw-object sweep (`V5__webhook_maintenance.sql` definer functions); scheduler-trigger job `ingestion-secret-expiry` (hourly; CronJob `aegispulse-cron-secret-expiry`, §5.1) in `workers/scheduler-trigger`, run locally with `make trigger JOB=ingestion-secret-expiry` (the k8s CronJob ships with the Phase 9 CronJob item)
- [x] Tests: clock-controlled expiry; orphan object deleted, referenced object retained

**Phase 4 exit evidence:** signed webhook via `scripts/demo/webhook-sign.ts` → 202 → message observed on broker; adversarial suite report; OpenObserve rejection metric screenshot.
**Phase note:** migrations are V3/V4 (V2 is ADR-0016's `enforced_rls_bypass`), plus `V5__webhook_maintenance` (FR-WHK-08 definer functions; no table changes). Delivered in slices: 4a sources + secret crypto; 4b verification, persistence, outbox, gateway webhook route, adversarial suite; 4c expiry + sweep. Spec `FR-WHK-01-08-webhook-ingestion`.
**Phase note:** status **`COMPLETE`** (2026-11-24): Runtime Completion Gate met — pipelines green, clean-state run ([clean-state-2026-11-24](docs/evidence/clean-state-2026-11-24.md)), merged to `main` in !1. History: slice 4a `RUNTIME-VERIFIED` locally (2026-11-24, [phase-04a](docs/evidence/phase-04a.md); E2E 183/183); slice 4b `RUNTIME-VERIFIED` locally (2026-11-24, [phase-04b](docs/evidence/phase-04b.md); E2E 192/192 incl. the adversarial suite). Slice 4c `RUNTIME-VERIFIED` locally (2026-11-24, [phase-04c](docs/evidence/phase-04c.md); `make trigger` exit 0). Phase exit ([phase-04](docs/evidence/phase-04.md)): demo → 202 → broker captured, adversarial suite 192/192; rejection metric visible in OpenObserve after two exit fixes (counter binding, local OTLP auth); still needs green pipelines.

---

### Phase 5 — Files Subsystem

#### FR-FILE-01 / FR-FILE-02 / FR-FILE-03 — Upload initiation, dedup & quotas
- [x] Migration `V3__files.sql` (`files`, `file_status_history`, RLS, indexes §7.3; numbered V3 because V2 is ADR-0016's RLS migration)
- [x] `FileService.initUpload` (`FileUploadService`): filename sanitizer, type allowlist, size bounds, dedup (Redis then DB), token-bucket quota, storage quota sum, session in Redis, presigned PUT (signed content-type/length) pointing at `PUBLIC_OBJECTS_URL`
- [x] Gateway `POST /v1/files/uploads/init`
- [x] Tests: dedup hit returns existing id; quota 429/413; filename `../../etc/passwd` rejected by the contract pattern (422), sanitized in depth, and never used in the key

#### FR-FILE-04 — Upload completion
- [x] `CompleteUploadUseCase` (`FileUploadService.completeUpload`): session check, HEAD object, size check, transition `INITIATED→UPLOADED` (optimistic `version`), outbox `file.uploaded` + `file.status.changed`, session delete
- [x] Gateway `POST /v1/files/uploads/{fileId}/complete` and `/abort`
- [x] Tests: complete without PUT → 409; double complete idempotent; concurrent completes → single transition

#### FR-FILE-05 — Validation consumer
- [x] Consumer adapter `files.validation.q` → `validateFile` service action; streaming SHA-256; magic-byte sniffing; ClamAV INSTREAM client behind `FILES_AV_ENABLED`; quarantine move
- [x] Outbox `doc.file.ready` / `notification.requested` (N-03)
- [x] Tests: EICAR test file → QUARANTINED; checksum mismatch → FAILED; PDF declared as CSV → QUARANTINED; redelivery no-op

#### FR-FILE-06 — Processing lifecycle API
- [x] Migration `V4__file_artifacts.sql` (V4 for the same V2 reason; adds the definer `files.file_tenant` for SERVICE callers)
- [x] `markProcessing`, `recordExtractionResult` (persists artifact row, emits `doc.extraction.completed|review_required`), `recordProcessingFailure`, `getInternalDownloadUrl`
- [x] Internal routes restricted to doc-extraction `act[]`
- [x] Tests: illegal transitions rejected; result recording idempotent by `(file_id, extractor_version)`

#### FR-FILE-07 / FR-FILE-08 / FR-FILE-09 — Reads & downloads
- [x] `getFile` with Redis status cache + invalidation; `listFiles`; `getDownloadUrl` with status rules, quarantine acknowledgement (TA only, `ops.audit.quarantine_download`), cached URL < TTL
- [x] Gateway routes `GET /v1/files*`
- [x] Tests: cached status invalidated on transition; quarantined download without ack → 403

#### FR-FILE-10 / FR-FILE-12 — Sweeps & retention
- [x] `sweepOrphans` (INITIATED > 1 h → EXPIRED, delete object, abort multipart), `purgeRetention`, `deleteFile` (soft)
- [x] scheduler-trigger jobs `files-orphan-sweep` (*/15), `files-retention` (daily) (CronJobs `aegispulse-cron-file-sweep` / `aegispulse-cron-retention` ship with Phase 9)
- [x] Tests: orphan flood scenario (100 inits, no PUT) → all EXPIRED, no leaked objects

#### FR-FILE-13 — Multipart uploads (Phase 5b, behind `MULTIPART_UPLOADS_ENABLED`)
- [x] Init returns `uploadId` + part URLs (16 MiB); complete with ETags; abort path
- [x] Tests: 200 MiB synthetic file upload through compose; each request < 100 MB

**Phase 5 exit evidence:** `scripts/demo/upload.ts` init→PUT→complete→VALIDATED with `doc.file.ready` on broker; EICAR quarantine evidence; orphan sweep logs.
**Phase note:** migrations V3/V4 (V2 is ADR-0016's). Slices: 5a init/dedup/quotas/complete/abort; 5c validation consumer; 5d lifecycle + reads; 5e sweeps/retention; 5b multipart (§2.7's "Phase 5b") last. Spec `FR-FILE-01-13-files`.
**Phase note:** status **`COMPLETE`** (2026-11-24): Runtime Completion Gate met — pipelines green, clean-state run ([clean-state-2026-11-24](docs/evidence/clean-state-2026-11-24.md)), merged to `main` in !1. History: slice 5a `RUNTIME-VERIFIED` locally (2026-11-24, [phase-05a](docs/evidence/phase-05a.md); E2E 213/213); slice 5c `RUNTIME-VERIFIED` locally (2026-11-24, [phase-05c](docs/evidence/phase-05c.md); real clamd EICAR → QUARANTINED); slice 5d `RUNTIME-VERIFIED` locally (2026-11-24, [phase-05d](docs/evidence/phase-05d.md); E2E 232/232); slice 5e `RUNTIME-VERIFIED` locally (2026-11-24, [phase-05e](docs/evidence/phase-05e.md); E2E 239/239, both files jobs via `make trigger`); slice 5b `RUNTIME-VERIFIED` locally (2026-11-24, [phase-05b](docs/evidence/phase-05b.md); 200 MiB multipart E2E). Phase exit captured in [phase-05](docs/evidence/phase-05.md) (`make demo-upload`, EICAR quarantine, orphan-sweep run); the pipeline is pending.

---

### Phase 6 — Events Archive & Stage-1 Classification

#### FR-EVT-01 / FR-EVT-02 / FR-EVT-03 — Archive consumer
- [x] Mongo migrations for `events_archive`, `events_restricted_audit`, `outbox`, `processed_messages` with validators + indexes (§7.6) (Phase 1 baseline `20261122000001-baseline.cjs`)
- [x] Consumer adapter `events.archive.q` → `archiveEvent`: envelope schema validation (poison → DLQ), restricted routing, duplicate-key = success, replay header handling
- [x] Mongo outbox relay (change in same transaction)
- [x] Tests: 3× redelivery → 1 document; invalid envelope → DLQ with `ENVELOPE_INVALID`; replay-tagged message updates `replay` only

#### FR-CLS-01 / FR-CLS-02 — Stage 1 rules & finalization
- [x] `src/domain/classification/rules-v1.ts`: baseline table, elevation rules, detectors (secret patterns, Luhn PAN, SSN, PII keys, MNPI lexicon), masking with `redactions[]`
- [x] `src/domain/classification/severity-resolver.ts` (§1.4.3) — pure function, property-tested (elevate-only invariant; exhaustive over all 1,440 automated combinations)
- [x] Finalize path for non-Stage-2 events → `classification.finalized`; Stage-2 path emits `classification.scan.requested` (scanner wiring in Phase 12; until then the request is recorded and `pendingAiScan=true`)
- [x] Loop prevention for `classification.*`, `intel.*`, `ops.*`, `registry.*`, `correlation.*`, `notification.*`
- [x] Tests: rule fixtures per event type; PAN/SSN/secret masking golden tests; Stage 1 p95 ≤ 5 ms benchmark

#### FR-EVT-04 / FR-EVT-05 / FR-EVT-06 — Query APIs
- [x] `searchEvents`, `getEvent`, `getCorrelationChain`, `searchEventsForEntities` with mandatory tenant filter (repository wrapper rejects tenantless queries), cursor pagination on `(occurredAt, eventId)`
- [x] Gateway routes `/v1/events*`; restricted tier only for CA
- [x] Tests: VIEWER cannot see restricted; correlation chain ordering by causation

#### FR-CLS-07 — Analyst override
- [x] `overrideClassification` with justification rule, `OVERRIDDEN`, history append, `classification.overridden`
- [x] Gateway `PATCH /v1/events/{id}/classification`
- [x] Tests: lowering severity without ANALYST role → 403; justification < 20 chars → 422

#### FR-EVT-07 (part 1) — Retention TTL
- [x] `expireAt` computation from tenant settings; TTL indexes; `purgeRetention` for restricted moves (part 1 = `expireAt` recomputed on a move to the restricted tier; the `events.purgeRetention` action is the cold-tier export, part 2)
- [x] Tests: TTL index present and `expireAt` correct per tenant

**Phase 6 exit evidence:** webhook from Phase 4 visible via `GET /v1/events?correlationId=` with lineage; masking demo with synthetic PAN; Mongo index listing.
**Phase note:** slices 6a archive + Stage 1 + finalization + Mongo outbox + source-trust amendment; 6b queries; 6c override; 6d retention TTL. Spec `FR-EVT-CLS-events-archive-classification`.
**Phase note:** status **`COMPLETE`** (2026-11-24): Runtime Completion Gate met — pipelines green, clean-state run ([clean-state-2026-11-24](docs/evidence/clean-state-2026-11-24.md)), merged to `main` in !1. History: slice 6a `RUNTIME-VERIFIED` locally (2026-11-24, [phase-06a](docs/evidence/phase-06a.md)); slice 6b `RUNTIME-VERIFIED` locally (2026-11-24, [phase-06b](docs/evidence/phase-06b.md); E2E 260/260 incl. the webhook-lineage and synthetic-PAN masking exit items); slices 6c + 6d `RUNTIME-VERIFIED` locally (2026-11-24, [phase-06c](docs/evidence/phase-06c.md)). Phase exit captured in [phase-06](docs/evidence/phase-06.md); the pipeline is pending.

---

### Phase 7 — Messaging Resilience & Dead Letters

#### FR-MSG-01 — Retry tiers & DLQ in every kit
- [x] Topology Job asserts retry queues `{queue}.retry.{1s,5s,30s}` and DLQs per §5.5 for every consumer queue (since Phase 1: `topology-assert` 6 exchanges / 58 queues / 71 bindings; the kits' integration suites run on the asserted contract topology)
- [x] Error classification conventions documented in `docs/steering/quality.md` (plus the DLQ headers); each consumer declares its mapping (`docs/specs/FR-MSG-01-04-messaging-resilience.md` §2 for the three consumers so far; later consumers in their own specs)
- [x] Tests (per language kit): transient error → 3 retries with increasing delay → DLQ with headers; permanent → DLQ immediately; nack-requeue when republish fails (TS, Java, Python integration suites against RabbitMQ 4: full chain gaps ≥ 1 s / 5 s / 30 s, DLX removed → original redelivered) ([phase-07](docs/evidence/phase-07.md))

#### FR-MSG-02 / FR-MSG-03 — Dead-letter registry & admin API
- [x] Mongo migration `dead_letters`, `leases` (in the Phase 1 baseline `20261122000001-baseline.cjs`; no new migration)
- [x] Consumer `events.deadletter.q` → `recordDeadLetter`; `ops.dead_letter.recorded` (raw consumer, kit `consumeRaw`) ([phase-07](docs/evidence/phase-07.md))
- [x] `listDeadLetters`, `getDeadLetter`, `replayDeadLetter`, `discardDeadLetter` + gateway `/v1/ops/dead-letters*`; audit events (`ops.audit.dead_letter_resolved`) ([phase-07](docs/evidence/phase-07.md))
- [x] Runbook `docs/runbooks/dlq.md`
- [x] Tests: poison message → registry record → replay after fix → processed once (`services/events/tests/integration/dead-letters.integration.test.ts`, E2E `dead-letters.e2e.test.ts`) ([phase-07](docs/evidence/phase-07.md))

#### FR-MSG-04 — DLQ alerting
- [x] OpenObserve alert definitions (`deploy/observability/alerts/dlq-spike.json`, format accepted by OpenObserve v1.1.2) + local equivalent check script (`make check-dlq-alert`; fired locally for 11 synthetic dead letters and for non-empty DLQs) ([phase-07](docs/evidence/phase-07.md))
- [ ] Tests: synthetic 11 dead letters in 5 min → alert fires (dev, Phase 18 evidence)

**Phase 7 exit evidence:** forced failure demo (scanner stub returning 500) showing retry timings and DLQ registry entry; replay of the dead letter.
**Phase note:** status **`IN PROGRESS`** (2026-11-24). All exit items are met locally ([phase-07](docs/evidence/phase-07.md)):
- **Demo:** `make demo-dlq` stops ClamAV, the real scanner, standing in for "scanner stub returning 500". The four attempts ran 1.0 s / 5.0 s / 30.0 s apart before the dead letter. The registry entry had `DEPENDENCY_UNAVAILABLE`, a message and a stack hash. Replay → `VALIDATED`, and both ops events were archived.
- **Verification:** E2E 294/294; full lint, typecheck, unit and integration suites green.

The FR-MSG-04 alert firing to ntfy in dev stays a Phase 18 item, as planned. Open gate items: pipelines green, merge to `main` (gate 1), and a clean-state run (gate 2).

---

### Phase 8 — Transactions, Scoring & Risk Cases (MVP vertical slice)

#### FR-TXN-01 / FR-TXN-06 — Transaction intake & status
- [x] Migration `V6__transaction_submissions.sql` (ingestion already has V4/V5 from Phase 4) ([phase-08a](docs/evidence/phase-08a.md))
- [x] `TransactionService.submit` (validation, FX currency check, idempotency with body hash), outbox `txn.submitted`; `getTransaction` ([phase-08a](docs/evidence/phase-08a.md))
- [ ] Gateway `POST /v1/transactions`, `GET /v1/transactions/{id}` (composes ingestion + cases clients) — POST done ([phase-08a](docs/evidence/phase-08a.md)); GET composition with cases in 8c
- [x] Tests: key reuse with different body → 409; same body → original response ([phase-08a](docs/evidence/phase-08a.md))

#### FR-TXN-04 — Risk scoring service (heuristic)
- [x] `services/risk-scoring`: `domain/heuristic_v1.py` (§1.4.4), static FX table `fx-static-v1`, Redis features with `feat:seen` idempotency, `POST /v1/score` (route `/internal/v1/score`) ([phase-08b](docs/evidence/phase-08b.md))
- [x] Pydantic request/response models generated from contracts (`aegis_contracts.openapi.*` via `make contracts`) ([phase-08b](docs/evidence/phase-08b.md))
- [x] Tests: factor table tests; redelivery does not inflate velocity; demo override only with demo tenant flag ([phase-08b](docs/evidence/phase-08b.md))
- [ ] Tests (moved from Phase 2, FR-TEN-08): a tenant settings change (`highValueThresholdUsd` / `highRiskCountries`) reaches scoring within 60 s (kit cache ≤ 60 s) — the orchestrator supplies the settings, so this runs with the saga (8e)

#### FR-TXN-03 — Score transaction saga
- [ ] `services/orchestrator`: consumer adapter `orchestrator.txn.q` → `ScoreTransactionSaga` (checkWatchlists → score → recordRiskEvaluation) with typed clients, SERVICE token, timeouts, breakers
- [ ] Tests: registry down → retries → DLQ; scoring timeout → retry; success path idempotent under redelivery (single evaluation row)

#### FR-TXN-05 / FR-CASE-01 / FR-CASE-02 / FR-CASE-03 — Evaluations & case state machine
- [ ] Migrations `V2__risk_evaluations.sql`, `V3__cases.sql` (cases, sequences, transitions, policy_evaluations, evidence, notes, dispositions)
- [ ] `CaseStateMachine` (domain, pure) with transition table; `CaseService.open/transition` with transition keys, optimistic locking, outbox events
- [ ] `recordRiskEvaluation` opening TRANSACTION_RISK cases ≥ 70; tenant-suspended suppression
- [ ] Enrichment timeout: delayed self-message + `runEnrichmentTimeouts` sweep (scheduler-trigger */5)
- [ ] Tests: exhaustive transition matrix test; duplicate open key → same case

#### FR-CASE-04 — Policy evaluation
- [ ] `domain/policy/PolicyV1` (§1.4.5) pure + property tests; `PolicyEvaluationService` storing factors; escalation side effects (`correlation.requested`, N-01)
- [ ] Tests: factor combinations table; CRITICAL escalation emits notification request

#### FR-CASE-05 / FR-CASE-06 / FR-CASE-07 / FR-CASE-08 — Case work & concurrency
- [ ] `listCases`, `getCase`, `getCaseTimeline`, `assignCase` (`expectedVersion`), `addCaseNote` (15-min lock), `recordDisposition` (four-eyes), `requestReevaluation`, `attachEvidence`, `autoResolveCleared` (daily)
- [ ] Gateway routes `/v1/cases*`
- [ ] Tests: concurrent transition race (two threads) → one wins, no duplicate audit; four-eyes violation 409

#### FR-AUD-01 / FR-AUD-02 / FR-AUD-03 — Immutable audit log
- [ ] Migration `V4__audit_log.sql` (table, triggers, grants, chain heads)
- [ ] `AuditService.append` with advisory lock, canonical JSON (RFC 8785 JCS) hashing; called inside every case transaction
- [ ] Consumer `cases.audit-ingest.q` → `ingestAuditEvent` (idempotent by source event)
- [ ] `listAuditEntries`, `verifyAuditChain` + nightly scheduler job `cases-audit-verify`; gateway `/v1/audit*`
- [ ] Tests: UPDATE/DELETE rejected by DB; tampering a row via superuser in test → verify reports `firstBrokenSeq`

**Phase 8 exit evidence (MVP slice):** compose E2E — signed webhook archived & classified (Stage 1), transaction burst → evaluation → case ESCALATED → audit chain verified; zero duplicates after replaying all queues 3×; trace waterfall across Node → Python → Java.
**Phase note:** status **`IN PROGRESS`** (2026-11-25). Slice 8a, transaction intake (FR-TXN-01 + the ingestion read of FR-TXN-06), is runtime-verified locally ([phase-08a](docs/evidence/phase-08a.md)). Slice 8b, risk scoring (FR-TXN-04), is integration-verified ([phase-08b](docs/evidence/phase-08b.md)); its call path from the orchestrator is verified with the saga in 8e. Next: 8c evaluations and case state machine (with the `GET /v1/transactions/{id}` composition), 8d audit log, 8e saga, 8f policy and case work, 8g exit.

---

### Phase 9 — Kubernetes, IaC & Secrets (homelab dev + prod)

#### Workstream: Manifests (`deploy/k8s/base`, overlays)
- [ ] Namespace, ResourceQuota, LimitRange, default-deny NetworkPolicy + per-component allows (§5.7.5)
- [ ] StatefulSets for postgres, mongo (rs0 init Job), redis, objectstore with `dedicated: storage` nodeSelector + toleration and PVC sizes (§5.3) — reviewed before first apply (PVC node binding is permanent)
- [ ] Deployments/Services for every runtime with probes, security contexts, requests/limits (§5.4), `automountServiceAccountToken: false`, PDBs where replicas > 1
- [ ] CronJobs (§5.1) running `scheduler-trigger` with SERVICE credentials; backup CronJobs (`pg_dump`, `mongodump`) to backups bucket
- [ ] Ingresses (`nginx-external`, `ssl-redirect: "false"`, SSE and body-size annotations §5.9)
- [ ] Topology Job, migration Jobs, seed Job (demo tenant only)
- [ ] `overlays/dev` (namespace `aegispulse-dev`, `*.rmwhs-dev.space` hosts, reduced requests, dev quota, `JWT_AUDIENCE=aegispulse-dev`), `overlays/prod` (namespace `aegispulse`, `*.rmwhs.com` hosts, full requests, gateway ×2), and `overlays/k3d-local`; a CI check fails if an overlay references the other environment's hostnames, namespace, vhost, or buckets
- [ ] `ci/env-sleep.sh` / `env-wake` (dev only; refuses `prod`) + nightly schedule; `make env-reset ENV=dev`
- [ ] Cross-environment isolation test: from a dev pod, connections to prod services and datastores fail; a dev-issued JWT is rejected by prod (`aud` and keys differ)
- [ ] `ci/lint-k8s.sh`: `kustomize build | kubeconform -strict` + `trivy config` + `ci/check-resource-budget.sh`

#### Workstream: Secrets (Infisical)
- [ ] 🛑 MANUAL (MB-03…MB-06) Infisical project structure: folders per component; secrets per §10.4 `[secret]` markers — catalog `deploy/infisical/secrets-catalog.yaml` (done), seeder `scripts/infisical/seed.py` (after MB-03/MB-04), operator install (MB-05)
- [ ] 🛑 MANUAL (MB-08) `InfisicalSecret` CR per component → `aegispulse-{component}-secrets`; Deployments use `secretKeyRef` only (operator identities with Kubernetes Auth)
- [ ] Startup fail-fast verified by deleting a secret key in a test namespace (pod CrashLoop with clear message)
- [ ] Runbook `docs/runbooks/key-rotation.md`: JWT keys, webhook KEK version bump, DB passwords, RabbitMQ users, object-store keys

#### Workstream: Bootstrap & edge
- [ ] `deploy/bootstrap/*.sh` (§9.3) idempotent scripts; executed and logged
- [x] Node roles (ADR-0015): `10-storage-node-disk.sh` run on `optiplex-tower` and `20-node-roles.sh` applied; mounts, roles and a PVC smoke test on the SSD recorded in [platform-node-roles](docs/evidence/platform-node-roles.md)
- [ ] Stateless workloads carry the preferred `node-role.kubernetes.io/worker` affinity; ClamAV the required one; placement asserted in evidence
- [ ] Cloudflare hostnames for both domains + WAF rules; verify via `curl -H "Host: …"` inside cluster first (cluster playbook)

#### Workstream: Backup & restore
- [ ] Restore drill (from prod backups) into `aegispulse-restore-test`; audit chain verify after restore (NFR-12)

**Phase 9 exit evidence:** `kubectl get pods -n aegispulse-dev -o wide` and `-n aegispulse -o wide` (storage pods on `optiplex-tower` with PVs on its data SSD; stateless pods on `optiplex`, spilling to `elitedesk-800` only under pressure), all `/readyz` 200 via both domains, MVP E2E suite passing against `rmwhs-dev.space` and smoke against `rmwhs.com`, cross-environment isolation test output, `kubectl describe node` allocations within budget, restore drill log.
**Phase note:** status `PENDING`.

---

### Phase 10 — CI/CD & DevSecOps Gates

#### Workstream: Pipeline
- [ ] Full `.gitlab-ci.yml` (§9.2) with per-runtime `rules:changes`, caches (pnpm store, Gradle, uv)
- [ ] `ci/build.sh` (kaniko, `--cache=true`, tags `$CI_COMMIT_SHORT_SHA`, outputs digest file)
- [ ] `ci/deploy.sh`, `ci/rollback.sh`, `ci/smoke.sh`, `ci/release.sh` per §9.2/§9.6

#### Workstream: Security gates
- [ ] Gitleaks (pre-commit + CI full history on main), GitLab Secret Detection
- [ ] GitLab SAST + Dependency Scanning + IaC SAST; SonarQube quality gate (coverage ≥ 75% overall, ≥ 85% service/domain; 0 new blocker/critical; hotspots reviewed) — custom rules: constant-time compare, no string-built SQL, no filename-derived object keys
- [ ] Trivy image + config scans; Syft CycloneDX SBOM attached to pipeline and as cosign attestation
- [ ] cosign sign on main/tags; verify in deploy
- [ ] ZAP baseline against console + ZAP API scan with `/v1/openapi.json` using a DAST service account; rules file `ci/zap-rules.tsv`; fail on High
- [ ] `.trivyignore`/ZAP exceptions require expiry date + ticket reference (`ci/check-exceptions.sh`)

#### Workstream: Process
- [ ] Protected branches/tags, MR approval rule, pipeline-must-succeed
- [ ] Rollback drill executed

**Phase 10 exit evidence:** green main pipeline with all stages; Gitleaks/SAST/Sonar/Trivy/ZAP report artifacts; cosign verify log; rollback drill log.
**Phase note:** status `PENDING`.

---

### Phase 11 — Document ETL & Extraction

#### FR-DOC-01 / FR-DOC-05 — Consumer & artifacts
- [ ] `services/doc-extraction` consumer adapter `doc.extraction.q` (prefetch 2) → `process_file` service; Files client (markProcessing, internal download URL, record result/failure); deterministic artifact keys; 120 s budget
- [ ] Tests: redelivery produces identical artifacts and a single `doc.extraction.completed`

#### FR-DOC-02 — Parsing & normalization
- [ ] Parsers: pdfplumber, Tesseract OCR fallback (≤ 50 pages), selectolax HTML, CSV/JSON preview; NFKC, de-hyphenation; chunker (1,000/100 tokens)
- [ ] Dockerfile includes Tesseract with layers < 95 MB
- [ ] Tests: golden documents → expected text hashes; scanned PDF triggers OCR path

#### FR-DOC-03 / FR-DOC-04 / FR-DOC-06 — Extraction, validation & confidence routing
- [ ] spaCy NER, ticker regex + `resolveEntities`, event-type rules + classifier, `clauses-v1` red flags with offsets
- [ ] `ExtractionResultV1` Pydantic (`extra="forbid"`), confidence formula, review routing
- [ ] Orchestrator `ExtractionReviewSaga` (`orchestrator.review.q`) → `cases.openCase(EXTRACTION_REVIEW)`
- [ ] Tests: golden extraction precision ≥ 0.85 (eval harness); malformed model output → REVIEW_REQUIRED, never silent

#### FR-TXN-02 — Transaction batch files
- [ ] CSV/JSON batch parser, chunked `submitTransactionBatch` (500/chunk), row-error artifact, counts on artifact row
- [ ] Ingestion `submitTransactionBatch` with per-row idempotency `{fileId}:{row}`
- [ ] Tests: 10,000-row CSV with 3% invalid rows → exact accepted/rejected counts; reprocessing creates no duplicates

#### FR-WHK-06 / FR-FILE-11 — Remote attachments with SSRF guard
- [ ] `registerRemoteFile` with DNS resolution + private-range blocking (IPv4/IPv6, incl. `169.254.169.254`, `fd00::/8`), connect-time re-check, redirect limits, size/time caps
- [ ] Ingestion attachment handling per allowlist
- [ ] Tests: SSRF suite (localhost, decimal IP, DNS rebinding fixture, redirect to private IP) all blocked

**Phase 11 exit evidence:** PDF filing upload → PROCESSED with artifacts + `doc.extraction.completed` archived/classified; batch CSV results; SSRF suite report.
**Phase note:** status `PENDING`.

---

### Phase 12 — AI Scanner, Stage-2 Classification & ML Scoring

#### FR-CLS-03 / FR-CLS-04 — Scanner service
- [ ] `services/sensitivity-scanner`: `POST /v1/scan`; Phase-12a deterministic lexicon stub `sensitivity-stub-v0`; Phase-12b TF-IDF + logistic regression `sensitivity-clf-v1.x` trained by `eval/runner/train_scanner.py` on golden data (model artifact versioned in object store + image)
- [ ] Optional `LlmAdjudicator` (Claude, `claude-haiku-5-5`) for confidence 0.40–0.60 behind `SCANNER_LLM_ENABLED`, budget counter, redacted input only, strict JSON output validated by Pydantic; disabled in CI
- [ ] Tests: macro-F1 ≥ 0.80 on golden set; adjudicator disabled path deterministic

#### FR-CLS-05 / FR-CLS-06 — Stage-2 patching & degradation
- [ ] Consumer `events.classification.q` → `runAiScan` with breaker; revision-guarded patch; restricted move in transaction; N-02 notification
- [ ] `sweepPendingScans` scheduler job (*/15)
- [ ] Tests: scanner down → events remain RULE_SCANNED with rule severity, later healed by sweep; duplicate scan results no-op

#### FR-TXN-04 (part 2) — Anomaly model
- [ ] IsolationForest `risk-iforest-v1` trained on synthetic transactions; `RISK_MODEL=iforest`; combined factors in response
- [ ] Tests: eval harness AUC ≥ 0.85 on labeled synthetic set; explainability factors present

**Phase 12 exit evidence:** eval report JSON; event lineage showing RULES → AI_SCANNER transition with versions; chaos: scanner killed mid-run, no lost classifications.
**Phase note:** status `PENDING`.

---

### Phase 13 — Connectors

#### FR-CON-01 — Connector management
- [ ] Migration `V5__connectors.sql` (`connectors`, `connector_items`)
- [ ] `ConnectorService` CRUD; gateway routes `/v1/connectors*`
- [ ] Tests: http URL rejected; interval bounds

#### FR-CON-02 / FR-CON-03 — Polling & normalization
- [ ] `RunConnectorUseCase`: advisory lock, conditional GET, SSRF guard reuse, parsers (RSS 2.0, Atom, SEC EDGAR Atom, JSON Feed + JSONPath mapping), normalization to `AEGIS_MARKET_EVENT_V1`, shared persistence/outbox path, cursor advance post-commit
- [ ] scheduler-trigger `connectors-run-due` (*/15)
- [ ] Tests: recorded feed fixtures (no live network in CI); 304 handling; duplicate items no new events

#### FR-CON-04 — Failure handling
- [ ] Failure counters, auto-pause at 5, N-05 notification, manual run throttle
- [ ] Tests: 5 consecutive 500s → PAUSED_ERROR + notification request

**Phase 13 exit evidence:** connector against a fixture feed served in compose → events archived; auto-pause demo.
**Phase note:** status `PENDING`.

---

### Phase 14 — Cross-Domain Correlation & Notifications

#### FR-COR-01 — Case correlation saga
- [ ] `CaseCorrelationSaga` on `correlation.requested` → `searchEventsForEntities` → `attachEvidence` (≤ 20 items)
- [ ] Tests: escalated case gains evidence from seeded filings; redelivery adds none

#### FR-COR-02 / FR-COR-03 — Classified signal saga
- [ ] `ClassifiedSignalSaga` on `classification.finalized` (filters per FR), resolution, watchlist check, `reevaluateOpenCases`, DOCUMENT_RISK open; fan-out bounds + truncation metric
- [ ] Cases `reevaluateOpenCases` (bounded, idempotent per trigger event)
- [ ] Tests: acquisition webhook mentioning watchlisted entity → DOCUMENT_RISK case; open TRANSACTION_RISK case re-evaluated to ESCALATED

#### FR-NOTIF-01 / FR-NOTIF-02 — Notification dispatch
- [ ] `NotificationDispatch` (orchestrator) rendering templates N-01…N-07 from `services/orchestrator/src/templates/`, ntfy client, dedup key, priority mapping, PII lint on templates
- [ ] Tests: template snapshot tests; duplicate requests within 10 min → one push (against a local ntfy container)

**Phase 14 exit evidence:** end-to-end cross-domain scenario from FR-DEMO-01 producing both correlation directions; ntfy push screenshots.
**Phase note:** status `PENDING`.

---

### Phase 15 — Replay & Cold Tier

#### FR-RPL-01 / FR-RPL-04 — Replay job API
- [ ] Mongo `replay_jobs`; `createReplayJob` (filter validation, allowlist, dry run count), `getReplayJob`, `cancelReplayJob`; gateway `/v1/events/replay*`; audit via `ops.replay.*`
- [ ] Tests: invalid filters 422; TA cannot replay another tenant

#### FR-RPL-02 / FR-RPL-03 — Replay runner & idempotent consumption
- [ ] Runner with Mongo lease, rate limit 200 msg/s, confirms, checkpoints, resume; generation headers; kits honor `replayGeneration` dedup
- [ ] Runbook `docs/runbooks/replay.md`
- [ ] Tests: replay 5,000 events into a new consumer queue (backfill) → processed once; replay into ORIGINAL_ROUTE → zero duplicate case transitions/audit entries; runner killed mid-job resumes

#### FR-EVT-07 (part 2) — Cold-tier export
- [ ] Monthly Parquet export of documents nearing expiry to `archive/` bucket, status `ARCHIVED`
- [ ] Tests: export → Parquet readable by polars with expected row counts

**Phase 15 exit evidence:** replay job progress output + post-replay duplicate audit query results (zero).
**Phase note:** status `PENDING`.

---

### Phase 16 — Data Intelligence & Evaluation

#### FR-INTEL-01 — Fact ingestion
- [ ] Migrations `analytics` V2–V4 (facts, rollups, drift, eval runs)
- [ ] Consumer `intel.facts.q` → `record_fact` (dispatch by eventType), idempotent by eventId
- [ ] Tests: each fact type mapping; redelivery dedup

#### FR-INTEL-02 / FR-INTEL-06 — Rollups & exports
- [ ] `run_rollups(scope)` SQL-first (CTEs) with idempotent upserts; scheduler jobs */15 and 02:00 UTC; Parquet export
- [ ] Tests: deterministic seeded facts → expected rollup values

#### FR-INTEL-03 — Drift detection
- [ ] PSI (10 fixed bins), confidence drop, disagreement rate; thresholds config; `intel.drift.detected` + N-07
- [ ] Tests: synthetic shifted distribution → PSI > 0.3 → HIGH

#### FR-INTEL-04 / FR-INTEL-05 — Feedback & read APIs
- [ ] Precision computation from disposition facts; read endpoints `/v1/intel/*` via gateway
- [ ] Tests: seeded TP/FP → precision values per version

#### FR-EVAL-01 / FR-EVAL-02 / FR-EVAL-03 / FR-EVAL-04 — Evaluation harness & CI gate
- [ ] Golden dataset (§2.19 counts) with `labels.jsonl`, dataset version file, generator scripts for synthetic content
- [ ] `eval/runner` CLI producing report JSON; `recordEvalRun`; `eval/baseline.json`
- [ ] CI job `eval:models` gate (thresholds + regression ≤ 3 points); adversarial webhook + idempotency suites wired
- [ ] Tests: harness self-test with a deliberately degraded model fails the gate

**Phase 16 exit evidence:** eval report + CI gate failing/passing demonstration; intel API responses; drift notification.
**Phase note:** status `PENDING`.

---

### Phase 17 — Gateway Completion & SSE

#### FR-SSE-01 / FR-SSE-02 — Streaming
- [ ] `gateway/nest-http/src/stream/` (`@Sse` controller returning an RxJS `Observable`): per-pod exclusive queue, tenant/role filter, projection mappers (no payloads), heartbeats, limits, idle timeout, graceful drain on shutdown
- [ ] Ingress annotations verified for SSE through Cloudflare (buffering off)
- [ ] Tests: two tenants streaming concurrently see only their events; 6th stream → 429

#### Workstream: Gateway hardening (cross-cutting, traces to FR-AUTH-06 and NFR-08)
- [ ] Complete public OpenAPI (every route in §8.3) with examples; Schemathesis fuzz run green
- [ ] Security headers, CORS (console origin), per-pod rate limit, body limits per route, error mapping table tests for every §8.4 code
- [ ] Typed service clients for every action used by controllers; controller lint rule: one service-client call per controller method, no `*.service.ts` files in the gateway, no datastore imports (except documented compositions: `GET /v1/transactions/{id}`)
- [ ] ZAP API scan clean (no High)

**Phase 17 exit evidence:** Schemathesis + ZAP reports; SSE demo recording.
**Phase note:** status `PENDING`.

---

### Phase 18 — Observability, Synthetic Monitoring & Chaos

#### Workstream: Observability (NFR-07)
- [ ] Dashboards + alerts as code (§9.7) imported into OpenObserve; alert → ntfy wiring
- [ ] Log redaction tests per runtime (seeded PAN/secret never appears in OpenObserve)
- [ ] Trace completeness check: demo scenario produces a single trace tree per correlation id across all runtimes

#### Workstream: Synthetic monitoring
- [ ] Install Uptime Kuma + ntfy (Helm/official manifests) if absent in cluster; monitors per §9.7 exported to `deploy/observability/uptime-kuma.json`
- [ ] Signed health-probe webhook source with dedicated secret

#### Workstream: Chaos & resilience (NFR-02, NFR-10)
- [ ] `scripts/demo/chaos/`: duplicate webhook flood (1,000 identical deliveries), consumer pod restarts mid-batch, scanner latency injection (toxiproxy in compose; scanner `CHAOS_LATENCY_MS` flag in dev; chaos never runs in prod), Mongo restart, orphan upload flood
- [ ] `tests/chaos/` assertions: zero lost events (archive count = accepted count), zero duplicate transitions/audit entries, DLQ only for injected poison
- [ ] 24 h soak at 2 req/s mixed traffic **in dev** (prod unaffected; record node allocation for both namespaces): 0 OOMKilled, outbox lag < 60 s

**Phase 18 exit evidence:** chaos report with counts; alert firing screenshots; soak metrics.
**Phase note:** status `PENDING`.

---

### Phase 19 — Analyst Console

#### FR-FE-01 — Authentication UI
- [ ] Login, first-login password change, logout, silent refresh (in-memory access token), route guards
- [ ] Playwright: login/logout, expired token refresh

#### FR-FE-02 — Live pipeline dashboard
- [ ] SSE client (`fetch-event-source`) with reconnect + REST resync, severity counters, feed virtualization
- [ ] Playwright: webhook sent → feed item appears ≤ 10 s

#### FR-FE-03 — Cases
- [ ] List with filters (URL-synced), detail with timeline/evidence/policy factors, assign, notes, disposition with four-eyes messaging
- [ ] Playwright: full disposition flow by two analysts

#### FR-FE-04 — Events explorer
- [ ] Filters, detail with lineage visualization (publisher → algorithm → final; history), override form
- [ ] Playwright: override requires justification

#### FR-FE-05 — Files
- [ ] Drag-and-drop, Web Crypto SHA-256 (streamed), presigned PUT with progress, status timeline, download
- [ ] Playwright: upload → PROCESSED; dedup message

#### FR-FE-06 — Administration
- [ ] Users, service accounts, webhook sources (one-time secret modal), connectors, entities/watchlists, replay jobs, dead letters, audit + verify (role-gated)
- [ ] Playwright: tenant admin flows; viewer cannot see admin nav and server returns 403

#### FR-FE-07 — Intelligence views
- [ ] Charts (drift, disagreement, latency, precision) with accessible tables as fallback
- [ ] Playwright snapshot tests

#### FR-FE-08 — Accessibility & responsiveness
- [ ] axe-core zero serious/critical; keyboard-only run-through; 360 px layouts; theme toggle
- [ ] Console image (`nginx-unprivileged`, CSP headers) deployed to `aegispulse.rmwhs-dev.space` (dev) and promoted to `aegispulse.rmwhs.com` (prod)

**Phase 19 exit evidence:** Playwright report (local + dev; smoke on prod), axe report, screenshots.
**Phase note:** status `PENDING`.

---

### Phase 20 — Portfolio Demo & Evidence Pack

#### FR-DEMO-01 / FR-DEMO-02 — Demo tooling
- [ ] `scripts/demo/scenario.ts` (FR-DEMO-01) targeting local, dev, or prod with printed correlation ids + links
- [ ] Chaos scripts finalized (Phase 18) and documented
- [ ] Tests: scenario runs green in CI against compose (`demo:compose` job, nightly)

#### Workstream: Portfolio checklist (source §9)
- [ ] Live end-to-end demo script + recording
- [ ] Event archive & replay verification (Mongo queries by `correlationId`/`final_severity`, lineage comparison, clean replay)
- [ ] Failure & chaos verification report (zero loss, zero duplicate transitions)
- [ ] Security gate artifacts (Gitleaks, SAST, SonarQube, Trivy, ZAP) + Infisical secret rotation evidence
- [ ] Observability & intelligence dashboards (trace waterfall, drift, disagreement, latency)
- [ ] `README.md` portfolio overview, architecture diagrams (Mermaid/C4 exported), threat model summary, ADR index, honest limitations

**Phase 20 exit evidence:** `docs/evidence/phase-20.md` linking every artifact above with SHAs and dates.
**Phase note:** status `PENDING`.


---

## 12. Project Rules & AI-IDE Guidelines

These rules bind every contributor and every AI coding assistant. `CLAUDE.md`, `AGENTS.md`, `.claude/skills/*`, and `docs/steering/*` restate them; if any of those disagree with this section, this section wins.

1. **Gateway/Service Separation.** External HTTP, SSE, and webhook traffic enters only through `gateway/nest-http`. Gateway code parses transport input, validates shape, authenticates/derives auth context, invokes typed service clients, and maps output. Domain logic, repositories, DB/cache/object-store clients, transactions, and outbox publication belong in named `services/<bounded-context>/` runtimes.
2. **Service Layer Supremacy.** All business logic lives in `src/service/` + `src/domain/` (TS), `..service` + `..domain` packages (Java), `service/` + `domain/` modules (Python). Handlers and consumers do three things only: parse input, call one service action, return/ack the result.
3. **Dispatch Layer = gateways/adapters only.** API gateways, HTTP route adapters, AMQP consumers, CronJob triggers, and webhook receivers are transport adapters and are never treated as service-layer components.
4. **Orchestration belongs to service modules.** Multi-step workflows (sagas, use cases) live in `src/service/orchestrators/` of the owning service (cross-service sagas in `services/orchestrator`). Never in handlers, consumers, controllers, or CronJobs.
5. **No direct DB access outside the owning service's `src/db/` (or `..db` package).** All queries go through typed repository/query functions; services never touch another service's schema, collection, keyspace, or bucket prefix.
   - *Worker applications and other dispatch adapters must not instantiate DB clients or use connection strings directly; they call service APIs/contracts.*
6. **No secrets in code.** Env vars only, sourced from Infisical (runtime) or GitLab masked variables (pipeline). No secrets in tests beyond generated throwaway values; fixtures with secret-like strings must be in the Gitleaks allowlist path `tests/fixtures/secrets-synthetic/`.
7. **Strict typing.** TS strict, no `any`, no implicit returns, explicit types on exported function signatures; Java no raw types, NullAway clean; Python `mypy --strict`, no untyped defs.
8. **Error handling.** Typed domain errors/results with stable codes (§8.4); no swallowed errors; no unhandled promise rejections; consumer outcomes are always ack, retry, or DLQ.
9. **Idempotency.** Every write that accepts an idempotency key enforces uniqueness in the database; every consumer is safe under redelivery and replay (NFR-02).
10. **Test coverage.** Every service-layer function has unit tests; every repository has integration tests against a real database container; every FR has at least one integration or E2E acceptance test named with its FR id (`it('FR-CASE-03 …')`).
11. **Migration discipline.** Never edit an existing migration (enforced by hook + CI); add a new `V{n}__` file. Expand/contract only.
12. **Environment parity.** Local, dev, and prod run the same images, migrations, topology, and code paths; differences are configuration only (overlays, Infisical environment). Prod only ever receives digests verified in dev; chaos, load, active DAST, and data resets target dev only.
13. **Contracts first.** Change `packages/contracts` (OpenAPI/AsyncAPI/JSON Schema) before implementation; regenerate types; never hand-edit `generated/`. Breaking changes need an ADR and a version bump.
14. **Envelope & messaging rules.** Every message uses the canonical envelope; binaries never go on the broker; publish only via outbox (or deterministic-id + confirms for storeless services); never declare topology at runtime.
15. **Spec change protocol.** If implementation needs something this document does not define, stop and propose an amendment: update `PROJECT.md` (and an ADR when it is an architectural decision) in the same MR, bump the document's "Last updated", and add a `CHANGELOG.md` entry under `Docs`.
16. **Evidence honesty.** Never mark a checklist item or FR status beyond what evidence proves (§11.0). Say "not verified" when it is not.
17. **Cluster rules (from K3S_CONTEXT).** Subdomain-only ingress with `nginx-external`; GitLab CI only; images by SHA/digest from `$CI_REGISTRY_IMAGE`; namespaces `aegispulse` (prod) and `aegispulse-dev` (dev), with subdomains under `rmwhs.com` (prod) and `rmwhs-dev.space` (dev); requests/limits on every container; no privileged containers/DinD; storage pods pinned to `optiplex` before first deploy; plain HTTP behind Cloudflare (no cert-manager annotations).
18. **AI guardrails — Claude/Cursor/Copilot/Codex must NOT:**
    - create new architectural patterns, services, queues, exchanges, tables, or env vars that are not defined here (propose an amendment instead);
    - put business logic, DB/cache/storage clients, or transactions in gateway handlers, consumer adapters, or CronJob triggers;
    - add HTTP/AMQP framework imports to `src/service/` or `src/domain/`;
    - edit existing migration files, `generated/` contract code, or `docs/evidence/` records of past phases;
    - weaken security controls (signature checks, RLS, authz checks, SSRF guards, redaction, rate limits) to make a test pass;
    - mock the database/broker in integration tests, or claim runtime verification from unit tests;
    - log secrets, raw webhook bodies, file contents, or unmasked PII;
    - introduce new dependencies without noting them in `docs/steering/tech.md` and the MR description;
    - use `:latest` image tags, `privileged: true`, or cluster-admin credentials in manifests/CI;
    - mark FRs or phases complete without evidence.

---

19. **Manual bootstrap steps.** Steps marked **🛑 MANUAL (MB-xx)** need credentials or access the repo and the AI agent never hold (cluster-admin, Infisical admin, Cloudflare, GitLab owner, node sudo). When work depends on an MB step that is not DONE in [docs/runbooks/manual-bootstrap.md](docs/runbooks/manual-bootstrap.md), stop; do not stub or work around it; give the operator the runbook's exact steps and what to report back (names, IDs, "done" — never secret values); verify read-only afterwards and record the status.

## 13. Infrastructure Cost Estimates

> Figures are order-of-magnitude planning estimates (USD/month, November 2026), not quotes. Re-price before any real spend.

### 13.1 Portfolio (homelab — actual)

| Item | Monthly cost | Notes |
|---|---|---|
| Compute (elitedesk-800 + optiplex + optiplex-tower, owned) | ~$11–16 | electricity only (~100–140 W combined average, estimate) |
| Kubernetes, GitLab CE, registry, Infisical, OpenObserve, RabbitMQ | $0 | self-hosted, open-source |
| Cloudflare (DNS, tunnel, WAF free tier) | $0 | free plan limits: 100 MB request bodies |
| Domains (`rmwhs.com` prod, `rmwhs-dev.space` dev, shared) | ~$1–3 | amortized annual renewals |
| ntfy | $0 | self-hosted or free public server with access token |
| LLM adjudicator (optional) | ≤ $5 | hard budget cap; default off |
| Off-node backup disk | ~$0–2 | amortized |
| **Total** | **~$10–20** | cost at rest ≈ cost under load (fixed hardware) |

What drives cost: nothing scales with load except electricity and the optional LLM; the real constraint is **capacity** (§5.4 budget), not money.

### 13.2 Production (reference — AWS us-east-1, on-demand)

| Service | Sizing | Est. monthly |
|---|---|---|
| EKS control plane | 1 cluster | ~$73 |
| EC2 worker nodes | 3–6 × m7g.large (Graviton) | ~$180–360 |
| RDS PostgreSQL | db.m7g.large Multi-AZ, 200 GB gp3, PITR | ~$300 |
| MongoDB Atlas | M30 3-node | ~$400 |
| Amazon MQ (RabbitMQ) | mq.m5.large cluster (3 brokers) | ~$650 |
| ElastiCache | 2 × cache.m7g.large | ~$230 |
| S3 + requests | 500 GB + lifecycle | ~$15–25 |
| ALB + WAF | 1 ALB, managed rules | ~$40–60 |
| NAT Gateways | 3 AZ | ~$100 + data |
| CloudFront + Route 53 | console + DNS | ~$5–15 |
| Secrets/KMS | KMS keys + API calls | ~$10 |
| Observability backend | OpenObserve on EKS or managed | ~$50–300 |
| **Total** | | **~$2,000–2,500** |

What drives cost: at rest the managed datastores and broker dominate (~75%); under load, worker nodes (KEDA-scaled extraction), data transfer, and observability ingestion grow.

---

## 14. Testing Plan

### 14.1 Unit Tests
- **Scope:** domain + service layers in every runtime with repositories, clients, and clocks faked via ports. Pure domain functions (severity resolver, policy, state machine, signature verification, normalization, detectors, scoring factors) get table-driven and property-based tests (fast-check / jqwik / hypothesis).
- **Tools:** Vitest (TS), JUnit Jupiter + AssertJ + jqwik (Java), pytest + hypothesis (Python).
- **Rules:** no network, no containers; < 30 s per runtime; test names include FR ids.

### 14.2 Integration Tests
- **Scope:** repositories, migrations, RLS, outbox relay, consumer kits, and each service's internal API against real PostgreSQL 18, MongoDB 8, Redis 8, RabbitMQ 4, object store, and ClamAV via Testcontainers. Happy path + error paths per domain: duplicate keys, optimistic lock conflicts, retry/DLQ, RLS denial, grant restrictions, restricted-collection routing.
- **Contract tests:** generated clients vs. provider stubs (schema conformance of every request/response/event against `packages/contracts`); AsyncAPI payload validation of every published message in integration runs.

### 14.3 End-to-End Tests
- **Scope:** HTTP + broker-level journeys against the running compose stack (CI `e2e-compose`), dev (`verify:dev:smoke`, full) and prod (`verify:prod:smoke`, read-mostly subset): webhook → archive → classification → correlation; transaction → case → disposition → audit verify; upload → validation → extraction → case; replay; DLQ replay; cross-tenant denial matrix; SSE delivery.
- **Tools:** Vitest + undici in `tests/e2e/`, Playwright for console (Phase 19), k6 for load (`tests/load/`), Schemathesis + ZAP for API robustness/security.

### 14.4 Specialized Suites
| Suite | Location | Trigger |
|---|---|---|
| Adversarial webhooks | `tests/security/webhooks.spec.ts` | every MR touching ingestion/gateway |
| Cross-tenant matrix | `tests/security/cross-tenant.spec.ts` | every MR |
| SSRF | `tests/security/ssrf.spec.ts` | ingestion/files changes |
| NetworkPolicy + cross-env isolation | `tests/security/netpol.sh` | post-deploy (dev; prod after promotion) |
| Idempotency/replay | `tests/e2e/idempotency.spec.ts` | nightly + release |
| Chaos | `tests/chaos/` | release candidates (**dev only**) |
| Golden-dataset eval | `eval/runner` | Python model changes + nightly |
| Load | `tests/load/*.js` | release candidates |

### 14.5 Test Data Strategy
- `scripts/dev/seed.ts` creates deterministic tenants, users, entities, watchlists, sources, connectors (stable UUIDs from a seed namespace).
- `eval/golden/` provides labeled synthetic documents, webhooks, and transactions; generators are deterministic given a seed (`--seed 20261122`).
- Time is injected (clock ports) so expiry/timeout tests are deterministic; random ids injectable for golden-output tests.
- No real personal or market data; any PAN/SSN-like values are synthetic and live under `tests/fixtures/secrets-synthetic/`.

### 14.6 CI Test Execution
| Stage | Tests |
|---|---|
| `lint` | static analysis, type checks, architecture/boundary checks |
| `test` | unit + integration (Testcontainers in runner pods), console component tests, `eval:models` (conditional) |
| `contract` | schema/OpenAPI/AsyncAPI validation + breaking-change diff, SonarQube gate |
| `scan` | Trivy, SBOM, layer-size check |
| `verify-dev` (main) | dev smoke E2E, ZAP baseline + active API scan, NetworkPolicy + isolation test |
| `verify-prod` (after promotion) | prod smoke subset, passive ZAP baseline |
| nightly schedule | full E2E on compose, idempotency/replay suite, demo scenario, drift job sanity |
| release candidate | chaos suite, load test, restore drill, rollback drill |

---

## Appendix A — Source Reconciliation & Template Adaptations

| # | Source statement | Decision in this document | Why |
|---|---|---|---|
| A1 | Template assumes AWS Lambda/SQS/RDS/Terraform and GitHub Actions | Homelab k3s + GitLab CI (from K3S_CONTEXT); AWS kept as reference production | Real deployment target; cluster mandates GitLab CI |
| A2 | Template §5 "AWS Infrastructure", §5.4 Lambda config, §5.5 SQS config | Adapted to Kubernetes workloads (§5.4) and RabbitMQ queues (§5.5); IAM → K8s SA + datastore principals (§5.7) | Same intent, real platform |
| A3 | Source diagram exchanges `external.events / risk.transactions / doc.ingestion / intel.audit` vs. topology `aegispulse.ingress/enrichment/domain/intelligence` | Use the `aegispulse.*` topology names only | Source topology section is more specific |
| A4 | Source puts HMAC verification "in the gateway" | Gateway passes raw bytes; `services/ingestion` verifies | Template forbids Redis/DB access and business logic in gateways |
| A5 | Source: Node "RabbitMQ consumer workers (saga coordination)" | Sagas live in `services/orchestrator` service layer (no datastore) | Template rule 4: orchestration belongs to service modules |
| A6 | Source envelope lacks `algorithm_confidence`, `rule_version`; `tenantId` is a slug; ids prefixed `file-` | Added fields (schemaVersion 1.1.0), `tenantId` = UUID + `tenantSlug`, plain UUIDs | Explicit lineage and consistent typing |
| A7 | Source file statuses lack an orphan state | Added `EXPIRED` | Orphan cleanup needs a terminal state |
| A8 | Source status list includes `ARCHIVED` without definition | `ARCHIVED` = exported to cold tier | Disambiguation |
| A9 | Source mentions "quarantine workflows" generally | File quarantine (AV/MIME) + restricted-event isolation | Concrete, testable scope |
| A10 | Template mandates `gen_random_uuid()` PKs | Kept; event ids are producer-generated UUIDv7 | Template compliance + time-ordered event ids |
| A11 | Source names "MinIO" | **SeaweedFS 4.54** (ADR-0011 accepted after 10/10 S3 compatibility checks; the MinIO community image is no longer published) | Avoid lock-in to an uncertain distribution |
| A12 | Source "SonarQube" vs. cluster capacity | SonarQube Community Build in-cluster if capacity allows; **open decision** for SonarCloud fallback | Elitedesk capacity is shared with GitLab |
| A13 | Cluster guide prefers plain manifests | Kustomize base + overlays (still plain manifests) | Two environments, minimal templating |
| A14 | Template §9.3 Terraform remote state bootstrap | Replaced by cluster bootstrap scripts (§9.3) | No Terraform-managed cluster resources |
| A15 | Template email notifications | ntfy push templates (FR-NOTIF) | Source specifies ntfy; no email in scope |
| A17 | Single homelab environment in v1.0 | `dev` (`aegispulse-dev`, `*.rmwhs-dev.space`) and `prod` (`aegispulse`, `*.rmwhs.com`) on the same cluster and tunnel (ADR-0014) | Owner-provided second domain on the same Cloudflare tunnel |
| A18 | Two-node cluster with `optiplex` as storage node (v1.0 baseline) | `optiplex-tower` is the storage node (1 TB data SSD); `optiplex` is the app-compute worker; budgets by tier (ADR-0015) | Owner added a third node with a dedicated data disk |
| A16 | v1.0 baseline gateway was plain Fastify (`gateway/fastify-http`) | NestJS on the Fastify adapter at `gateway/nest-http` (ADR-0013); internal service adapters stay plain Fastify | Owner decision; evaluated with no architectural risk |

Open decisions (record outcome via ADR before the phase that needs it): SonarQube hosting (Phase 10), kaniko vs. buildah (Phase 10), Uptime Kuma/ntfy hosting location (Phase 18). Decided: object store → SeaweedFS (ADR-0011, Phase 0).

## Appendix B — Glossary

| Term | Meaning |
|---|---|
| Canonical envelope | The versioned message wrapper in §6.4 |
| Dispatch layer | Transport adapters: gateway, route adapters, consumers, CronJob triggers |
| Elevate-only | Automated classification may raise but never lower severity/sensitivity |
| Evidence pack | `docs/evidence/phase-NN.md` record proving runtime verification |
| MNPI | Material non-public information |
| Outbox | Table/collection holding events written atomically with state, relayed to the broker |
| PSI | Population Stability Index, drift metric for score distributions |
| Replay generation | Integer identifying a replay pass so consumers can dedupe per pass |
| RLS | PostgreSQL Row-Level Security |
| Saga | Multi-step, idempotent cross-service use case without persisted saga state |
| Stage 1 / Stage 2 | Deterministic rules classification / asynchronous AI scanner classification |
