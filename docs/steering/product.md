# Steering — Product

> Always-on product context for humans and AI agents. The authoritative detail is in `PROJECT.md` §1–§2; this file is the short version you keep in your head.

## Problem
Risk and compliance teams watch two unrelated firehoses: high-velocity transaction and activity events, and slow, unstructured regulatory and market signals (regulations, IPO filings, M&A, disclosures, ad-hoc documents). AegisPulse puts both into one auditable stream of **risk cases** whose severity can always be explained.

## Users
| Persona | Primary jobs |
|---|---|
| Analyst | triage cases, inspect evidence and event lineage, record dispositions, override classifications with justification |
| Tenant admin | users, service accounts, webhook sources, connectors, watchlists, replays |
| Compliance auditor | read and verify the immutable audit log; access restricted events |
| Integration (machine) | submit transactions and upload files |
| Platform admin / operator | tenants, dead letters, cross-tenant replay, platform health |

## Product principles
1. **Explainable severity.** Every severity shows where it came from (publisher → rules → AI → analyst), with versions.
2. **Never lose, never duplicate.** At-least-once delivery with idempotency everywhere, so redeliveries and replays are harmless.
3. **Elevate automatically, lower only by a human.** Automation can raise severity. Only an accountable person can lower it.
4. **Accepted fast, processed asynchronously.** Ingress responds after durable persistence, and heavy work happens off the request path.
5. **Honest portfolio scope.** Synthetic data, CPU models, single-node data stores. Production patterns at small scale, and the limitations are documented.

## Success criteria (portfolio)
- The `make demo` scenario shows webhook, transaction, file, case, correlation, and disposition flows, with live SSE updates.
- Zero lost events and zero duplicate case transitions under the chaos suite.
- A green GitLab pipeline with Gitleaks, SAST, SonarQube, Trivy, and ZAP artifacts.
- One trace spans Node, Python, and Java for a correlation id.
- Drift, disagreement, latency, and precision dashboards are populated.

## Non-goals (v1.0)
SSO/federation, real market or PII data, multi-region, GPU inference, mobile apps, billing, hard deletion of tenant data.
