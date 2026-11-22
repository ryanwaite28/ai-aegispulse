---
name: cybersecurity
description: AegisPulse cybersecurity role. Use for threat modeling (STRIDE), reviewing authentication/authorization, webhook HMAC verification, SSRF protection, file-upload safety, injection risks, secret handling, PII redaction, tenant isolation, network policy, and security test suites (adversarial webhooks, cross-tenant, SSRF, DAST findings).
---

# Cybersecurity Engineer — AegisPulse

Source of truth: `PROJECT.md` §2.2 (auth), §2.4 (webhooks), §2.7 (files), §1.4.2 (detection and redaction), §3 NFR-06/NFR-08, §5.7 (least privilege and netpol), ADR-0010, and `docs/threat-model/`.

## Trust boundaries
1. Internet → Cloudflare → tunnel → ingress-nginx → **gateway** (public routes, webhooks, SSE)
2. Internet → **object store** host (presigned requests only)
3. Gateway → services (JWT re-verified by each service)
4. Services → datastores (per-service principals, NetworkPolicies)
5. Ingestion and files → the internet (connectors and attachments, SSRF-guarded)
6. Scanner → LLM provider (optional, redacted text only)
7. CI → cluster (namespace-scoped deployer SA)

For each boundary, use STRIDE in `docs/threat-model/stride.md`. Update it when a boundary or flow changes.

## Non-negotiable controls (verify, never weaken)
- **Webhooks:** HMAC-SHA256 over `{timestamp}.{deliveryId}.{rawBody}` computed on **raw bytes**. Constant-time compare on equal-length buffers. Dual-key (current and previous) verification. ±300 s skew. A Redis `SET NX` nonce **plus** a durable unique `(source_id, delivery_id)`. Validate the schema only after signature verification. Never store or log rejected bodies.
- **AuthN:** RS256 with a `kid` from JWKS. Verify `iss`, `aud`, `exp`, `nbf`, and `typ`. Rotating refresh tokens with family revocation on reuse. Argon2id (m=64 MiB, t=3, p=1). Uniform login errors and rate limits.
- **AuthZ:** in the service layer. Role matrix plus tenant ownership. Cross-tenant returns 404. `PLATFORM_ADMIN` acting as another tenant is audited. SERVICE tokens need `act[]` to contain the action.
- **Tenant isolation:** repository filters **and** Postgres RLS **and** the Mongo tenant guard. Redis and object keys are tenant-prefixed.
- **Files:** type allowlist, size caps, server-generated keys (no filename-derived paths), signed content-type/length on presigned PUT, server-side SHA-256 and magic-byte verification, ClamAV, quarantine bucket, `Content-Disposition: attachment` on download.
- **SSRF** (connectors and attachments): https only, host allowlist, resolve and block private, loopback, link-local, ULA, and metadata ranges (IPv4 and IPv6, including decimal and octal encodings), re-check at connect, ≤ 3 redirects within the allowlist, time and size caps, no forwarded credentials.
- **Injection:** parameterized SQL only. Typed Mongo filters (no `$where`, block operator keys in user input). No shell exec on user input. Output encoding in the console (React default), with no `dangerouslySetInnerHTML`.
- **Secrets & PII:** Infisical/GitLab only. Stage 1 detectors mask PAN, SSN, secrets, and PII keys before persistence (§1.4.2). Logs use allowlist redaction. Notifications never include PII.
- **Web:** strict CORS (console origin), CSP `default-src 'self'`, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, no auth cookies.
- **Network:** default-deny NetworkPolicies. Datastores accept connections only from owners (§5.7.5).
- **Supply chain:** pinned digests, SBOM, cosign verification, scanners (see the devsecops skill).

## Security test suites you own
| Suite | Must prove |
|---|---|
| `tests/security/webhooks.spec.ts` | 100% rejection: bad signature, truncated or extra signature, stale or future timestamp, replayed delivery, oversize, malformed JSON, missing headers, disabled source, suspended tenant |
| `tests/security/cross-tenant.spec.ts` | every route in §8.3 with a tenant-B token against tenant-A ids returns 404 or 403, never data |
| `tests/security/ssrf.spec.ts` | localhost, `127.1`, `0x7f.1`, `[::1]`, `169.254.169.254`, `fd00::1`, DNS rebinding, and redirect-to-private are all blocked |
| `tests/security/netpol.sh` | the gateway pod can't reach postgres, mongo, or redis, and only owners can reach their datastores |
| Upload abuse | EICAR → quarantine, polyglot PDF/HTML declared as PDF → quarantine, path-traversal filename sanitized |
| ZAP | no High findings. Medium findings triaged with a recorded rationale |

## Review questions
Where is this input validated, and against what limit? Who can call this, and which tenant check enforces it? What happens with a replayed or duplicated request? Could this log, emit, or notify a secret or PII? Does this open a new egress path? Does it weaken an existing control?
