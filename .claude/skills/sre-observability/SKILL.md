---
name: sre-observability
description: AegisPulse SRE/observability role. Use for structured logging, OpenTelemetry traces/metrics, OpenObserve dashboards and alerts, health/readiness/liveness probes, graceful shutdown, Uptime Kuma + ntfy monitoring, SLO/latency targets, capacity and resource limits, chaos and soak testing, runbooks and incident response.
---

# SRE / Observability Engineer — AegisPulse

Source of truth: `PROJECT.md` §3 NFR-01, NFR-07, NFR-10, NFR-11, NFR-15, §9.7, Phase 18, and the cluster playbook in `docs/K3S_CONTEXT.md` §4.

## Telemetry contract
- **Logs:** JSON to stdout with `ts, level, service, version, env, traceId, spanId, correlationId, tenantId?, eventId?, msg`, plus `errorCode` on errors. Allowlist redaction. Info level by default, with no per-message info logs on hot consumer paths (use debug or metrics).
- **Traces:** W3C `traceparent` over HTTP **and** AMQP headers. Spans for every inbound request, outbound call, DB query batch, publish, and consume. Span attributes: `aegis.tenant_id`, `aegis.event_type`, `aegis.queue`, `aegis.case_id` (never PII).
- **Metrics:** the names in NFR-07 exactly. Low-cardinality labels only (no ids in labels).
- **Export:** OTLP/HTTP → OpenObserve (`openobserve` namespace) with streams `aegispulse_logs`, `aegispulse_traces`, `aegispulse_metrics`.

## Probes & lifecycle (NFR-11)
- `/livez` checks only that the process is alive. `/readyz` checks config, secrets, owned datastores, the migration version, and the broker connection. `/healthz` is aggregated JSON for humans.
- Startup retries dependencies with backoff for up to 60 s. Startup probes give JVMs 120 s.
- On SIGTERM: stop the HTTP listener → cancel consumers → drain in-flight (≤ 20 s) → flush the outbox batch and telemetry → close pools. `terminationGracePeriodSeconds: 30`.

## SLO-style targets (prod; measured in dev first, idle)
Webhook p95 ≤ 150 ms · transaction intake p95 ≤ 100 ms · webhook → `classification.finalized` p95 ≤ 15 s · txn → evaluation p95 ≤ 3 s · file complete → PROCESSED p95 ≤ 60 s (5 MiB) · outbox lag < 60 s.

## Alerts (as code in `deploy/observability/alerts/`)
DLQ spike, outbox lag, consumer error rate, webhook rejection rate, API p95, archive write failures, audit-chain failure, and pod restarts. Every alert routes to ntfy `aegispulse-alerts` and has a linked runbook in `docs/runbooks/`.

## Capacity (NFR-03, NFR-15)
- Requests and limits on every container (§5.4). Keep `ci/check-resource-budget.sh` green.
- JVM `-XX:MaxRAMPercentage=70`. Node `--max-old-space-size` ≤ 75% of limit. Prefetch bounds memory.
- Watch for OOMKilled and CPU throttling. Raise limits only for the specific workload, and only with evidence.

## Chaos & soak (Phase 18)
**Dev only, never prod.** Duplicate webhook flood, consumer restarts mid-batch, scanner latency (toxiproxy or `CHAOS_LATENCY_MS`), Mongo restart, orphan upload flood, then a 24 h soak. Assert zero loss (archive count = accepted), zero duplicate transitions, 0 OOMKilled, and outbox lag < 60 s.

## Debugging playbook (cluster-specific)
Pending → `kubectl describe pod` (Events, Node-Selectors, Tolerations). CrashLoop → `kubectl logs --previous`. "Fixed but not fixed" → exec in and read the rendered config. Proxy errors → find which hop generated them. Always set `KUBECONFIG=~/.kube/config` explicitly.

## Runbooks you maintain
`docs/runbooks/{dlq,replay,restore,key-rotation,incident}.md`. Each has: symptoms, dashboards and queries, a step-by-step fix, verification, and rollback.
