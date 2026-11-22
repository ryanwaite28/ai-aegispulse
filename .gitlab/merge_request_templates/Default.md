## Summary
<!-- What and why, in 2–4 sentences. -->

## Traceability
- FR/NFR ids:
- Phase (PROJECT.md §11):
- Spec: docs/specs/
- ADR (if architectural):

## Checklist
- [ ] Contracts updated first and `make contracts` leaves no diff
- [ ] Layering respected: no business logic or datastore clients in gateway, workers, or adapters
- [ ] Migrations are new files only, expand/contract (no edits to existing `V*__*.sql`)
- [ ] Unit tests for every changed service/domain function
- [ ] Integration tests against real dependencies (Testcontainers) for repositories, consumers, and routes
- [ ] Authz (role × tenant) and idempotency/redelivery cases tested
- [ ] No secrets, raw bodies, or PII in logs; input limits enforced
- [ ] New dependencies recorded in `docs/steering/tech.md`
- [ ] `PROJECT.md` §11 checklist/ledger updated **honestly**
- [ ] `CHANGELOG.md` `[Unreleased]` entry added
- [ ] Phase exit? Evidence file `docs/evidence/phase-NN.md` attached

## Verification performed
```text
<!-- paste the exact commands you ran and their results -->
```
