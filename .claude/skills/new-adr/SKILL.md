---
name: new-adr
description: Create a new AegisPulse Architecture Decision Record from docs/adr/0000-template.md and apply the matching PROJECT.md amendment in the same change. Invoke as /new-adr "<decision title>".
---

# /new-adr $ARGUMENTS

1. Find the next number: `ls docs/adr | sort | tail -n 2`. Create `docs/adr/NNNN-<kebab-title>.md` from `0000-template.md`.
2. Fill in Context (forces and constraints, citing `PROJECT.md` sections), Decision (testable "We will …"), Options considered (at least 2, with an honest cons column), Consequences (including accepted risks and follow-up phases), and Verification (the CI check, test, or runtime evidence that proves it holds).
3. If this ADR supersedes another, set the old one to `Superseded by ADR-NNNN` and link both ways.
4. **Amend `PROJECT.md`** in the same change so the decision appears in every affected section (use `/amend-project` steps). An ADR that isn't reflected in `PROJECT.md` is not in effect.
5. Add the row to `docs/adr/README.md`, plus a `CHANGELOG.md` `### Docs` entry.
6. Run the `systems-architect` skill checklist against the decision before finalizing.
