# ADR-0010 — Registry-issued JWTs verified by every service

- **Status:** Accepted
- **Date:** 2026-11-22
- **PROJECT.md sections affected:** §2.2, §5.7.4, §8.3
- **Related:** NFR-08

## Context
There's no service mesh in the homelab. Plain HTTP runs in-cluster behind Cloudflare TLS. Zero trust therefore has to be enforced at the application layer.

## Decision
- `services/registry` issues RS256 access tokens (15 min) and rotating refresh tokens (7 d, reuse detection), and publishes JWKS with the current and previous keys.
- The gateway **and** every owning service verify tokens locally. Services enforce RBAC and tenant ownership in their service layer. Cross-tenant access returns 404.
- Internal calls use SERVICE client-credentials tokens with `aud=aegispulse-internal` and an `act[]` allowlist of permitted actions.
- NetworkPolicies add defense in depth. Production adds mesh mTLS.

## Consequences
- Every service carries a JWT verifier through the platform kits.
- Key rotation needs a runbook and a drill (Phase 2).

## Verification
The authz matrix tests, the cross-tenant suite, and the JWKS rotation drill.
