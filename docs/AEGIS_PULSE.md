# AegisPulse: Distributed Risk, Regulatory & Market Intelligence Platform

**Author:** Ryan M. Waite  
**Role:** Systems Architect & Principal Software Engineer  
**Stack:** Node.js (TypeScript) • Java (Spring Boot) • Python • RabbitMQ • PostgreSQL • MongoDB • Redis • S3/MinIO • Kubernetes • Full DevSecOps Toolchain

---

## 1. Executive Summary

**AegisPulse** is a multi-tenant, event-driven distributed microservices platform designed to ingest, correlate, score, archive, and analyze both **high-velocity operational/financial events** and **unstructured regulatory/market signals** (e.g., newly published regulations, IPO filings, M&A announcements, compliance disclosures, and ad-hoc document uploads).

The platform unifies four operational, analytical, and platform planes into a cohesive reference architecture:

1. **Real-Time Event & Risk Anomaly Plane:** Ingests transactional and operational streams, performs feature enrichment and ML/heuristic risk scoring, and manages stateful risk cases and quarantine workflows.
2. **Document, Filing & Ad-Hoc File Intelligence Plane:** Ingests filings, disclosures, ad-hoc uploaded files, and external regulatory/market triggers (via verified webhooks and normalized connectors), manages binary/file lifecycle safely outside the message broker, parses unstructured content, extracts entities/clauses, and links findings to tracked entities.
3. **Event Audit, Classification & Provenance Plane (Events Service):** Captures routed platform events into MongoDB with structured `sensitivity` metadata, provenance/severity lineage (`publisher_stated_severity`, `algorithm_severity`, `final_severity`), and lifecycle `status` tracking—enabling auditability, replay, and classifier evaluation.
4. **Data Intelligence & Feedback Plane:** Aggregates historical and streaming signals into curated analytical models, monitors data/model drift and lineage, evaluates extraction and classification quality, and feeds analyst dispositions back into scoring rules.

---

## 2. Core Architectural Goals & Engineering Principles

* **Polyglot Service Specialization:** Use the right runtime for each architectural boundary rather than forcing a single language across all concerns:
  * **Node.js (TypeScript):** Non-blocking edge API gateway, webhook ingestion/verification, presigned/ad-hoc file upload orchestration, BFF/status streaming (SSE/WebSockets), and RabbitMQ consumer orchestration.
  * **Java (Spring Boot):** Strongly typed core domain models, multi-tenant RBAC/entitlements, stateful workflow engines, transactional consistency, and immutable compliance audit trails.
  * **Python:** Unstructured document ETL/parsing, NLP/LLM entity & clause extraction, sensitivity/severity scanning APIs, ML anomaly scoring APIs, and analytical/drift intelligence pipelines.
* **Event-Driven Resilience & Lean Messaging:** Decouple ingress from heavy processing using RabbitMQ exchanges, routing keys, dead-letter exchanges/queues (DLX/DLQ), exponential backoff retries, correlation/trace IDs, and strict consumer idempotency. Keep large files out of RabbitMQ by passing lightweight file metadata references (`fileId`, `storageKey`, `checksum`) rather than raw binary payloads.
* **Defense-in-Depth Data Governance:** Enforce explicit `sensitivity` and severity provenance metadata on events, validate producer claims with deterministic rules and asynchronous AI classification, and isolate access/retention boundaries intentionally.
* **Zero-Trust & Shift-Left DevSecOps:** Treat security scanning, secret injection, quality gates, and observability as foundational infrastructure primitives inside GitLab CI/CD and Kubernetes.
* **Spec-Driven AI Execution:** Govern AI-assisted development with explicit PRDs, interface contracts, Architecture Decision Records (ADRs), repository guardrails (`CLAUDE.md` / `AGENTS.md`), and automated evaluation harnesses.

---

## 3. High-Level System Architecture

```
                        ┌──────────────────────────────────────────────┐
                        │        External & Internal Producers         │
                        │  • Public Webhooks (Regulations, IPOs, M&A)  │
                        │  • Connector Pollers (RSS/Atom/Filing Feeds) │
                        │  • Client Transaction & Activity Streams     │
                        │  • Ad-Hoc Document & Filing Uploads          │
                        └──────────────────────┬───────────────────────┘
                                               │ HTTPS (HMAC / JWT / mTLS)
                                               ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                           KUBERNETES CLUSTER (aegispulse)                              │
│                                                                                        │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │                       NODE.JS EDGE & ORCHESTRATION LAYER                         │  │
│  │  • API Gateway, Webhook Ingress & File Upload Gateway (Presigned / Multipart)    │  │
│  │  • Canonical Event Normalizer & Outbound Publisher                               │  │
│  │  • RabbitMQ Consumer Workers (Saga Coordination, Retries, Circuit Breakers)      │  │
│  └───────────┬──────────────────────────────────────────────────────────┬───────────┘  │
│              │ Publish Canonical Envelopes                              │ Consume      │
│              ▼                                                          ▼              │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │                              RABBITMQ MESSAGE BROKER                             │  │
│  │  • Exchanges: external.events | risk.transactions | doc.ingestion | intel.audit  │  │
│  │  • Dedicated Archive Binding -> Events Archive Queue                             │  │
│  │  • Queues + Dead Letter Exchanges (DLX/DLQ) + Retry Queues (TTL Backoff)         │  │
│  └───────┬──────────────────────────┬──────────────────────────┬────────────────────┘  │
│          │                          │                          │                       │
│          ▼                          ▼                          ▼                       │
│  ┌───────────────────────┐ ┌─────────────────────────┐ ┌────────────────────────────┐  │
│  │  EVENTS SERVICE       │ │  FILES SUBSYSTEM        │ │  PYTHON AI / ML / ETL      │  │
│  │  • Event Archive &    │ │  • Files Service        │ │  • Risk & Anomaly Scoring  │  │
│  │    Replay Engine      │ │  • Presigned URLs,      │ │  • Document ETL & OCR      │  │
│  │  • Sensitivity &      │ │    Checksums & Status   │ │  • Entity/Clause Extraction│  │
│  │    Severity Lineage   │ │  • Object Storage       │ │  • AI Sensitivity Scanner  │  │
│  │  • MongoDB Store      │ │    (S3/MinIO) + Redis   │ │  • Data Intel & Drift      │  │
│  └───────────────────────┘ └─────────────────────────┘ └─────────────┬──────────────┘  │
│                                                                      │                 │
│                                                                      ▼                 │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │                       JAVA SPRING BOOT CORE BUSINESS PLANE                       │  │
│  │  • Tenant, Watchlist & Entity Mgmt   • Policy Engine & RBAC                      │  │
│  │  • Risk Case State Machine           • Immutable Compliance Audit Log            │  │
│  └─────────────────────────────────────────┬────────────────────────────────────────┘  │
│                                            │                                           │
│                                            ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │                       DATA & STORAGE PERSISTENCE LAYER                           │  │
│  │  • PostgreSQL (Core Domain, Files Metadata & Analytical/Feature Rollup Schemas)  │  │
│  │  • MongoDB (Canonical Event Archive, Sensitivity & Provenance History)           │  │
│  │  • Object Storage (S3/MinIO for Raw Filings, Ad-Hoc Files & Webhook Payloads)    │  │
│  │  • Redis (Nonce/Replay Cache, Upload Sessions, File Status Cache, Rate Limits)   │  │
│  └──────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                        │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │                 PLATFORM SECURITY, SECRETS & OBSERVABILITY PLANE                 │  │
│  │  • Infisical (Runtime Secret Injection)   • OpenObserve (Logs, Metrics, Traces)  │  │
│  │  • Uptime Kuma + ntfy (Synthetic Checks & Push Alerts)                           │  │
│  └──────────────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Detailed Component Breakdown

### 4.1 Node.js Edge, Webhook & File Upload Gateway (TypeScript)
* **Webhook & External Event Ingestion (`POST /webhooks/:source`):**
  * Listens for external regulatory announcements, IPO filings, M&A disclosures, and market alerts.
  * Performs constant-time HMAC-SHA256 signature verification, timestamp skew validation ($\pm 5$ minutes), and Redis-backed nonce/delivery-ID replay protection.
  * Supports a **Connector Normalization Pattern** so polled feeds (RSS/Atom/public filing APIs) emit into the exact same canonical event contract as push webhooks.
  * Archives raw payloads to object storage, publishes a canonical envelope to RabbitMQ, and returns `202 Accepted` immediately.
* **File Upload & Ad-Hoc Ingestion Gateway (`POST /files/uploads/init`, `POST /files/uploads/:fileId/complete`, `GET /files/:fileId`):**
  * Handles ad-hoc file submissions (PDF filings, regulatory documents, CSV/JSON data batches) without buffering large binaries in RabbitMQ.
  * Issues short-lived presigned upload URLs (or streams validated uploads to the Files Service), enforces tenant quotas/rate limits via Redis, and triggers downstream `file.uploaded` events upon completion.
* **API Gateway & Real-Time Status:**
  * Exposes authenticated REST endpoints for transaction event submission, case inspection, event replay requests, and file status queries, plus Server-Sent Events (SSE) for live pipeline progress.
* **RabbitMQ Orchestration Consumers:**
  * Consumes inbound events with configured `prefetch` limits, manages correlation/causation IDs, invokes Python enrichment/scoring/scanning APIs with timeouts and circuit breakers, and coordinates downstream domain updates.

### 4.2 Events Archive & Classification Service (MongoDB)
* **Dedicated Multi-Exchange Event Recorder:**
  * Subscribes via dedicated durable queues bound to core topic/fanout exchanges (`aegispulse.ingress`, `aegispulse.enrichment`, `aegispulse.domain`, `aegispulse.intelligence`) to capture an authoritative record of published platform events.
  * Enforces idempotent writes in MongoDB using a unique index on `(tenantId, eventId)` so at-least-once RabbitMQ redeliveries never create duplicate archive records.
* **Sensitivity & Provenance Lineage Tracking:**
  * Requires a structured `sensitivity` and `severity` classification block on archived events rather than relying on an unverified producer label alone.
  * Tracks provenance across three distinct severity signals plus lifecycle state:
    * `publisher_stated_severity`: Raw severity/urgency asserted by the upstream producer or webhook source (if provided).
    * `algorithm_severity`: Severity/sensitivity inferred by deterministic policy rules and/or the Python AI/ML scanner (alongside confidence score and model/rule version).
    * `final_severity`: The authoritative effective severity used for downstream routing, alerting, retention, and analyst overrides.
    * `status`: Processing lifecycle state (`INGESTED`, `RULE_SCANNED`, `AI_SCANNED`, `CLASSIFIED`, `OVERRIDDEN`, `ARCHIVED`, `REPLAYED`).
* **Two-Stage Sensitivity Classification Strategy:**
  * **Stage 1 (Synchronous Deterministic Rules):** Fast policy rules inspect event type, source, and schema keys at ingestion/archive time to tag or elevate sensitivity immediately and redact/mask raw secrets or high-risk PII where required.
  * **Stage 2 (Asynchronous AI Scanner Enrichment):** Events containing unstructured text, filings, or ambiguous (`UNCLASSIFIED`) payloads trigger the Python AI classification API asynchronously, patching `algorithm_severity`, `final_severity`, and `status` in MongoDB without adding LLM latency to every high-throughput event.
* **Collection Strategy & Replay API:**
  * Uses a primary `events_archive` collection indexed by `{ tenantId: 1, correlationId: 1, occurredAt: -1 }`, `{ tenantId: 1, "classification.final_severity": 1, occurredAt: -1 }`, and `{ status: 1, occurredAt: 1 }`, with optional isolated collections (`events_restricted_audit`) reserved strictly for compliance tiers requiring distinct access controls or TTL retention policies.
  * Exposes controlled internal replay endpoints (`POST /events/replay`) to republish historical events by `correlationId`, time window, or `eventType` when recovering from downstream bugs or backfilling new models.

### 4.3 Files Subsystem (Files Service, Metadata DB, Redis & Object Storage)
* **Files Service:**
  * Manages the complete lifecycle of uploaded and ingested files (`INITIATED` $\rightarrow$ `UPLOADED` $\rightarrow$ `VALIDATED` $\rightarrow$ `PROCESSING` $\rightarrow$ `PROCESSED` / `FAILED` / `QUARANTINED`).
  * Validates MIME types, byte size limits, SHA-256 checksums, and tenant ownership before emitting `doc.file.ready` events to RabbitMQ for Python ETL workers.
  * Serves authorized download/preview requests via time-bounded presigned URLs.
* **Files Metadata Database (PostgreSQL):**
  * Stores durable relational records (`fileId`, `tenantId`, `uploadedBy`, `originalFilename`, `storageBucket`, `storageKey`, `contentType`, `sizeBytes`, `sha256Checksum`, `sourceType` [`AD_HOC_UPLOAD` | `WEBHOOK_ATTACHMENT` | `CONNECTOR_FETCH`], `status`, `createdAt`, `updatedAt`).
* **Redis Coordination & Cache Layer:**
  * Tracks short-lived upload session tokens (`upload:session:{id}`) for presigned upload completion checks and orphan cleanup.
  * Caches hot file status responses and signed download URLs (bounded strictly below URL expiration TTL).
  * Deduplicates identical file uploads within a configurable window using `(tenantId, sha256Checksum)` keys and enforces per-tenant upload rate/quota limits.
* **Object Storage (S3 / MinIO):**
  * Stores immutable raw binaries (`raw/{tenantId}/{yyyy}/{mm}/{dd}/{fileId}`), extracted text/chunk artifacts, and Parquet exports cleanly separated from transactional databases and RabbitMQ.

### 4.4 Java Spring Boot Core Business Microservices
* **Entity, Tenant & Watchlist Service:**
  * Manages multi-tenant isolation, role-based access control (RBAC), monitored corporate entities, tickers, counterparties, and regulatory watchlists.
* **Risk Case & Compliance Workflow Service:**
  * Implements deterministic state machines for risk cases (`OPEN` $\rightarrow$ `ENRICHING` $\rightarrow$ `POLICY_EVALUATED` $\rightarrow$ `ESCALATED` / `CLEARED` / `RESOLVED`).
  * Evaluates business rules combining ML risk scores, document extraction red flags, file-based ad-hoc findings, and watchlist matches.
  * Enforces idempotency keys on all state transitions and records an immutable compliance audit trail (capturing *which* event, file, or model version triggered every state change).
* **Cross-Domain Correlation Trigger:**
  * When a high-severity transaction anomaly fires, triggers a cross-check for recent filings/news on the entity; conversely, when a critical regulatory or M&A webhook or ad-hoc filing arrives, triggers re-evaluation of open cases for affected entities.

### 4.5 Python AI, ML, ETL & Data Intelligence Services
* **Event Feature & Anomaly Scoring API (FastAPI):**
  * Computes velocity/behavioral features and returns structured risk scores, confidence intervals, and top contributing factors (explainability metadata).
* **Sensitivity & Severity AI Scanner API:**
  * Evaluates unstructured event payloads and extracted document snippets to infer sensitivity categories (`PII`, `MNPI`, `REGULATORY`, `FINANCIAL`) and `algorithm_severity` with model version metadata.
* **Document & File ETL / Extraction Service:**
  * Pulls validated files from S3/MinIO via `fileId` metadata, parses PDF/HTML/CSV/JSON content, performs text normalization and chunking, extracts named entities (organizations, agencies, tickers, executives), classifies event types (`REGULATION_PUBLISHED`, `IPO_FILED`, `ACQUISITION_ANNOUNCED`), and flags material risk clauses.
  * Enforces strict Pydantic output schemas and confidence thresholds so malformed or low-confidence extractions route to human review rather than silent corruption.
* **Data Intelligence & Feedback Pipeline:**
  * **Analytical Rollups:** Aggregates ingestion latency, entity risk trajectories, source reliability, and sector/regulatory exposure into analytical schemas.
  * **Drift & Quality Monitoring:** Tracks score distribution shifts, extraction confidence degradation, publisher-vs-algorithm severity disagreement rates, and schema anomalies over time.
  * **Closed-Loop Evaluation:** Ingests analyst case dispositions (`TRUE_POSITIVE`, `FALSE_POSITIVE`, `NEEDS_REVIEW`) from Spring Boot to benchmark model/rule precision and catch regressions.

---

## 5. Canonical Event Envelope & Messaging Contracts

All RabbitMQ messages across Node.js, Python, Spring Boot, the Events Service, and the Files Subsystem adhere to a versioned canonical envelope:

```json
{
  "eventId": "019352b8-7c4a-7e10-9a21-4f8c2d1e9b01",
  "correlationId": "corr-98f1a2b3-4c5d-6e7f-8a9b-0c1d2e3f4a5b",
  "causationId": "019352b8-7110-7b22-8c33-1a2b3c4d5e6f",
  "tenantId": "tenant-acme-capital",
  "schemaVersion": "1.1.0",
  "eventType": "external.regulatory.published",
  "source": "sec-edgar-relay",
  "occurredAt": "2026-11-21T21:30:00Z",
  "ingestedAt": "2026-11-21T21:30:01.142Z",
  "idempotencyKey": "sec-edgar-relay:rel-2026-8841:v1",
  "classification": {
    "sensitivity": "CONFIDENTIAL",
    "categories": ["REGULATORY", "FINANCIAL"],
    "publisher_stated_severity": "MEDIUM",
    "algorithm_severity": "HIGH",
    "final_severity": "HIGH",
    "classification_source": "AI_SCANNER",
    "classifier_version": "sensitivity-clf-v1.2.0",
    "status": "CLASSIFIED"
  },
  "payload": {
    "externalId": "rel-2026-8841",
    "category": "REGULATION_PUBLISHED",
    "title": "Updated Cross-Border Liquidity Reporting Requirements",
    "fileId": "file-019352b9-1122-7a33-9b44-5c6d7e8f9a0b",
    "storageUri": "s3://aegispulse-raw/tenant-acme-capital/2026/11/21/rel-2026-8841.pdf",
    "mentionedEntities": ["ACME Holdings", "Globex Clearing"]
  }
}
```

### RabbitMQ Topology & Failure Handling
* **Topic Exchanges:** `aegispulse.ingress`, `aegispulse.enrichment`, `aegispulse.domain`, `aegispulse.intelligence`
* **Archive Fanout/Topic Bindings:** Dedicated durable queue (`events.archive.q`) bound with wildcard routing (`#`) across core exchanges so the Events Service captures all routed events asynchronously without blocking primary consumers.
* **Retry Strategy:** Transient downstream failures (e.g., Python worker timeout or MongoDB transient write error) route to TTL-delayed retry queues (`1s` $\rightarrow$ `5s` $\rightarrow$ `30s`) with bounded retry headers (`x-retry-count`).
* **Dead-Letter Queues (DLQ):** Poison messages or exhausted retries land in dedicated `*.dlq` queues with full error metadata and an administrative replay endpoint.

---

## 6. Kubernetes & Full DevSecOps Architecture

### 6.1 GitLab CI/CD Pipeline Stages
Every merge request and main-branch build passes through automated quality and security gates:

1. **Pre-Commit & Secret Hygiene (`Gitleaks`):** Scans commit history and diffs for leaked API keys, webhook signing secrets, MongoDB/PostgreSQL credentials, or object storage keys before code is merged.
2. **Build & Polyglot Test Suites:** Runs unit and contract tests across Node.js (Vitest/Jest), Spring Boot (JUnit 5 + Testcontainers), and Python (Pytest + schema/eval checks).
3. **Static Analysis & Quality Gates (`SonarQube`):** Enforces code coverage thresholds, cyclomatic complexity limits, bug/code-smell checks, and static security rules (e.g., constant-time signature checks, path traversal prevention on file keys, SQL/NoSQL injection prevention).
4. **Container & IaC Vulnerability Scanning (`Trivy`):** Scans multi-stage Docker images (Node, JVM, Python) and Kubernetes/Helm manifests for critical/high CVEs and misconfigurations (root containers, missing resource limits).
5. **Ephemeral/Staging Deployment & DAST (`OWASP ZAP`):** Deploys to staging on Kubernetes and executes automated OWASP ZAP baseline and OpenAPI security scans against the Node.js gateway, webhook endpoints, and file upload/download routes.

### 6.2 Runtime Secrets, Observability & Alerting
* **Infisical (Secret Management):** Stores webhook HMAC signing keys (supporting dual-key rotation), RabbitMQ credentials, PostgreSQL/MongoDB/Redis secrets, S3/MinIO keys, and internal service tokens. Injected dynamically into Kubernetes pods via the Infisical Kubernetes Operator—zero plaintext secrets in Git or static manifests.
* **OpenObserve (Unified Observability):** Collects structured JSON logs, Prometheus/OTel metrics (queue depth, consumer lag, MongoDB archive throughput, file upload latency, inference latency, webhook signature rejection rate), and distributed OpenTelemetry traces spanning Node.js $\rightarrow$ RabbitMQ $\rightarrow$ Events/Files/Python $\rightarrow$ Spring Boot.
* **Uptime Kuma + ntfy (Synthetic Monitoring & Incident Alerting):** Probes external ingress, webhook health endpoints, file gateway readiness, and internal health checks, dispatching instant push notifications via **ntfy** on endpoint degradation, TLS expiration, or DLQ spikes.

---

## 7. Spec-Driven AI Development & Evaluation Workflow

To ensure high architectural integrity while accelerating delivery with AI coding tools:

1. **Specification First (SDD / OpenSpec):** Every service and capability starts with a concise PRD, OpenAPI/AsyncAPI contract, and Architecture Decision Record (ADR) before implementation code is generated.
2. **Authoritative Context (`CLAUDE.md` / Repo Guides):** Maintain explicit architectural rules covering idempotency requirements, file pointer conventions, sensitivity/severity lineage rules, error handling, structured logging, security boundaries, and testing standards.
3. **Deterministic & AI Evaluation Harnesses:**
   * Maintain a curated golden dataset of sample regulatory texts, IPO notices, M&A announcements, ad-hoc filing uploads, and adversarial/malformed webhook payloads.
   * Run automated evaluation tests verifying entity extraction precision, sensitivity/severity classification accuracy (comparing `publisher_stated_severity` vs. `algorithm_severity`), schema compliance, replay rejection, and duplicate-event idempotency.
4. **Cost & Latency Discipline:** Track inference latency, token/compute consumption per document/event, and two-stage classification routing decisions inside the Data Intelligence plane.

---

## 8. Phased Implementation Roadmap

### Phase 1: Foundation, Core Vertical Slice & File/Event Skeleton
* Set up monorepo/polyrepo structure, Docker Compose local environment (RabbitMQ, PostgreSQL, MongoDB, Redis, MinIO), and base Kubernetes manifests.
* Implement **Node.js Gateway** (`POST /webhooks/market-regulatory-event` with HMAC verification + replay guard, plus `POST /files/uploads/init` & `complete`) publishing canonical envelopes to **RabbitMQ**.
* Implement **Events Service** archiving routed events into MongoDB with idempotent `(tenantId, eventId)` indexes and baseline `classification` metadata.
* Implement **Files Service** managing object storage keys, checksums, PostgreSQL metadata, and Redis upload sessions.
* Implement **Python Extraction/Scoring Stub** and **Spring Boot Case Service** persisting entities, cases, and audit logs, wired with **OpenTelemetry** $\rightarrow$ **OpenObserve**.

### Phase 2: Full Enrichment, Sensitivity Scanning, Cross-Domain Correlation & Resilience
* Add real NLP/ML extraction, anomaly scoring, and **AI Sensitivity/Severity Scanner** logic in Python with strict Pydantic validation and golden-dataset tests.
* Implement two-stage classification updates (`publisher_stated_severity` $\rightarrow$ `algorithm_severity` $\rightarrow$ `final_severity` + `status` transitions) in the Events Service and Spring Boot policy engine.
* Implement RabbitMQ TTL retry queues, Dead Letter Queues (DLQs), circuit breakers in Node.js, orphan file cleanup jobs, and idempotency enforcement in Spring Boot.
* Build cross-pollination triggers linking external webhook events and ad-hoc file uploads to active transaction risk cases.

### Phase 3: Data Intelligence, Replay & Feedback Loop
* Stand up analytical rollup tables and Python batch/micro-batch pipelines for risk trends, source latency, publisher-vs-algorithm severity disagreement rates, and drift metrics.
* Add controlled event replay workflows in the Events Service and analyst case disposition endpoints in Spring Boot (`TRUE_POSITIVE` / `FALSE_POSITIVE`) feeding back into Python evaluation metrics.

### Phase 4: Hardened Kubernetes & Complete DevSecOps Gates
* Integrate **Infisical** operator for dynamic secret injection and key rotation across all services and datastores.
* Enforce **Gitleaks**, **SonarQube**, **Trivy**, and **OWASP ZAP** gates in **GitLab CI/CD**.
* Configure **Uptime Kuma + ntfy** synthetic health monitors and chaos/failure-injection test scenarios (pod restarts, duplicate webhook floods, orphan file uploads, Python worker latency spikes).

---

## 9. Portfolio Demonstration & Verification Checklist

* [ ] **Live End-to-End Demo Script:** Signed webhook generator + ad-hoc filing uploader simulating a new regulation, IPO, acquisition, and batch file upload triggering real-time scoring, sensitivity elevation, case escalation, and SSE updates.
* [ ] **Event Archive & Replay Verification:** Querying MongoDB by `correlationId` and `final_severity`, demonstrating provenance comparison (`publisher_stated_severity` vs. `algorithm_severity` vs. `final_severity`), and replaying a historical event stream cleanly.
* [ ] **Failure & Chaos Verification:** Proof of zero data loss and zero duplicate state transitions under duplicate webhook replays, repeated file uploads (Redis SHA-256 dedup), RabbitMQ consumer restarts, and Python service timeouts.
* [ ] **Security Gate Artifacts:** Passing GitLab pipeline runs showing Gitleaks, SonarQube, Trivy, and OWASP ZAP reports, plus Infisical secret rotation in Kubernetes.
* [ ] **Observability & Intelligence Dashboards:** OpenObserve distributed trace waterfall across all runtimes alongside Data Intelligence drift, classification disagreement, and latency metrics.