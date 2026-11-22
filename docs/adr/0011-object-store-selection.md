# ADR-0011 — S3-compatible object store selection

- **Status:** Accepted (2026-11-22, Phase 0)
- **Date:** 2026-11-22
- **PROJECT.md sections affected:** §4.3, §5.4, §6.3, §10.3, Appendix A11
- **Related:** ADR-0009

## Context
The source names MinIO. MinIO's community distribution and licensing have changed recently, so image availability and terms must be checked before we depend on it. AegisPulse uses only the S3 API: presigned PUT/GET, HEAD, copy, delete, multipart, and versioning.

## Decision (constraint already accepted)
- Application code uses the AWS S3 SDKs only, with endpoint and path-style configuration, and no vendor-specific APIs.
- Phase 0 evaluates candidates against these criteria: an available maintained container image, a license compatible with self-hosting, presigned URL support (including signed headers), multipart, bucket versioning, per-user policies by prefix, and resource footprint under 768 Mi.

## Options evaluated (2026-11-22)
| Option | Finding |
|---|---|
| MinIO (community) | **Rejected**: `minio/minio` no longer exists on Docker Hub (HTTP 404), so there is no maintained community image to pin. |
| Garage | **Rejected**: AGPL-3.0, and it lacks bucket versioning and prefix-scoped policies, both required by §5.6 / §5.7.3. |
| RustFS | Not chosen: active but newer, with less operational history. |
| **SeaweedFS 4.54** | **Chosen**: Apache-2.0, actively published multi-arch image, single-process `weed server -s3`, passed every compatibility check below. |

## Decision
Use **SeaweedFS `chrislusf/seaweedfs:4.54`** as the S3-compatible object store in local, dev, and prod (single node, `weed server -s3`). Principals and scopes live in an `s3.json` identities file rendered from secrets. Prefix scoping uses the `Action:bucket/prefix/*` form; the trailing `/*` is required, and `bucket/prefix/` does **not** grant access.

## Verification (evidence)
`scripts/dev/objectstore_compat.py` (also `make objectstore-compat`) ran **10/10 PASS**, both against a scratch container and against the local compose stack using project identities: bucket create; presigned PUT with signed Content-Type (matching 200, mismatched 403); HEAD size; presigned GET; multipart (2 parts); server-side copy + delete; bucket versioning (Enabled, 2+ versions); prefix-scoped principal (allowed prefix OK, other prefix AccessDenied). Details are in `docs/evidence/phase-00.md`.

## Consequences
- Application code still uses only the AWS S3 SDKs (endpoint + path-style), so a future swap is an image and config change only.
- SeaweedFS's identity file is rendered from secrets at startup (compose `config-render`; Phase 9 uses an InfisicalSecret-backed volume).
- Lifecycle rules (`quarantine/` 30 d, `tmp/` 1 d) must be verified for SeaweedFS support in Phase 5. Fallback: a retention CronJob.
