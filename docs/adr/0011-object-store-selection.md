# ADR-0011 — S3-compatible object store selection

- **Status:** Proposed (to be decided in Phase 0)
- **Date:** 2026-11-22
- **PROJECT.md sections affected:** §4.3, §5.4, §6.3, §10.3, Appendix A11
- **Related:** ADR-0009

## Context
The source names MinIO. MinIO's community distribution and licensing have changed recently, so image availability and terms must be checked before we depend on it. AegisPulse uses only the S3 API: presigned PUT/GET, HEAD, copy, delete, multipart, and versioning.

## Decision (constraint already accepted)
- Application code uses the AWS S3 SDKs only, with endpoint and path-style configuration, and no vendor-specific APIs.
- Phase 0 evaluates candidates against these criteria: an available maintained container image, a license compatible with self-hosting, presigned URL support (including signed headers), multipart, bucket versioning, per-user policies by prefix, and resource footprint under 768 Mi.

## Options to evaluate
| Option | Notes |
|---|---|
| MinIO (community) | named in the source; verify current image distribution and license |
| Garage | lightweight, S3-compatible; verify versioning and policy support |
| SeaweedFS (S3 gateway) | mature; heavier configuration |
| Other maintained S3-compatible servers | evaluate on the same criteria |

## Consequences
The choice changes only images and bootstrap scripts, not application code.

## Verification
Phase 0 runs the compatibility test suite (presign, multipart, versioning, prefix policy) against the chosen store, and the outcome is recorded by amending this ADR to Accepted.
