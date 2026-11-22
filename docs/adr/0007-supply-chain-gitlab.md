# ADR-0007 — Supply chain and DevSecOps gates on self-hosted GitLab

- **Status:** Accepted
- **Date:** 2026-11-22
- **PROJECT.md sections affected:** §9.2, §9.4, §3 NFR-08/NFR-17
- **Related:** source §6.1

## Context
The source requires Gitleaks, SonarQube, Trivy, and OWASP ZAP. The cluster standard prefers GitLab-native analyzers, kaniko (no privileged builds), and pushes registry traffic through Cloudflare, which has a 100 MB body cap. Public Sigstore keyless signing doesn't trust a self-hosted GitLab OIDC issuer.

## Decision
- Gitleaks runs as a pre-commit hook and a CI job, alongside GitLab Secret Detection, SAST, Dependency Scanning, IaC SAST, and Container Scanning.
- The SonarQube quality gate is required. Hosting is an open decision (in-cluster Community Build or SonarCloud) to be settled before Phase 10.
- Trivy covers images and config. Syft generates CycloneDX SBOMs.
- **cosign uses a key pair.** The private key lives in a protected GitLab variable and the public key is committed. `ci/deploy.sh` verifies every digest before applying.
- Images are tagged with the short SHA and deployed by digest. Every layer must be under 95 MB.
- ZAP runs a baseline scan of the console and an API scan of `/v1/openapi.json` after the homelab deploy, and fails on High findings.

## Consequences
- DAST runs after deploy, not before, because there is a single environment. A manual rollback job is provided.
- The kaniko upstream is archived, so we reevaluate in Phase 10.

## Verification
Phase 10 evidence: report artifacts for every gate, a cosign verify log, and a rollback drill.
