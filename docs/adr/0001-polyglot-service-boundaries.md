# ADR-0001 — Polyglot service boundaries

- **Status:** Accepted
- **Date:** 2026-11-22
- **PROJECT.md sections affected:** §4.1, §6.1, §6.3
- **Related:** NFR-04, NFR-09

## Context
The source concept (`docs/AEGIS_PULSE.md` §2) calls for Node.js, Java, and Python, each where it fits best. If the boundaries are drawn badly, three languages triple the toolchain cost without any benefit.

## Decision
- **Node.js/TypeScript:** I/O-bound edge and pipeline services, namely `gateway/fastify-http`, `ingestion`, `files`, `events`, `orchestrator`, and `workers/scheduler-trigger`.
- **Java/Spring Boot:** strongly typed domain state with transactional consistency, namely `registry` (tenancy, identity, RBAC, entities, watchlists) and `cases` (evaluations, case state machine, policy, immutable audit).
- **Python:** documents, NLP, ML, and analytics, namely `risk-scoring`, `sensitivity-scanner`, `doc-extraction`, and `data-intel`.
- Each language has one shared technical kit (`packages/{ts,java,py}-platform`), and every runtime implements the same layering.
- Cross-language contracts are OpenAPI, AsyncAPI, and JSON Schema in `packages/contracts`, with generated types.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| Polyglot by boundary (chosen) | shows the intended specialization, plays to each ecosystem's strengths | three toolchains, more CI time |
| Node everywhere | one toolchain | weak ML/NLP ecosystem; doesn't meet the portfolio goal |
| Java everywhere | strong typing | heavy for edge I/O and ML |

## Consequences
- Contracts become the integration surface, so contract tests are mandatory (`PROJECT.md` §14.2).
- CI uses `rules:changes` per runtime to control pipeline time.
- JVM memory requires 384 Mi or more of requests per Java service, which counts against the capacity budget (§5.4).

## Verification
Architecture tests in each runtime, the contract job, and a single trace spanning all three runtimes (Phase 8 evidence).
