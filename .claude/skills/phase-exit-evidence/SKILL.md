---
name: phase-exit-evidence
description: Collect and record real runtime evidence for an AegisPulse implementation phase against the Runtime Completion Gate (PROJECT.md §11.0), then update the status ledger honestly. Invoke as /phase-exit-evidence NN.
---

# /phase-exit-evidence $ARGUMENTS

Goal: produce `docs/evidence/phase-$ARGUMENTS.md` with **real** evidence, and update the status only as far as that evidence supports.

1. Read Phase $ARGUMENTS in `PROJECT.md` §11, including its FR blocks, checklist, and "Phase exit evidence" line, plus §11.0 (gate items 1–8).
2. Create the file from `docs/evidence/_template.md`. Fill in the SHA (`git rev-parse HEAD`), the UTC date, and the environment(s).
3. For each gate item, run the commands and paste the trimmed real output:
   - clean start: `make reset && make up && make migrate`, then `/readyz` for every runtime in the phase
   - the test suites for the phase's FRs (unit, integration, E2E), with the FR ids visible in the output
   - async proofs: queue/DLQ inspection, redelivery ×3 results, outbox state queries
   - security checks named in the phase
   - observability: OpenObserve query results or screenshot paths in `docs/evidence/assets/phase-$ARGUMENTS/`
   - homelab runs (from Phase 9 on): `kubectl get pods -n aegispulse -o wide`, smoke results against the `rmwhs.com` hosts
4. If a command fails or can't run (missing environment, cluster unavailable), **record that**. Never substitute expected output.
5. Update the status ledger in `PROJECT.md` §11.0 and each FR spec to the level actually proven:
   - `RUNTIME-VERIFIED` requires gate items 1–8 with evidence in **both** compose and homelab (homelab from Phase 9 onward; earlier phases cap at local runtime with a note).
6. Add a `CHANGELOG.md` `### Status` line linking the evidence file.
7. Report: the status reached, gaps, and follow-ups.
