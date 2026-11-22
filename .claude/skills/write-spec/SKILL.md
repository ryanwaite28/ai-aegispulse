---
name: write-spec
description: Draft or update the implementation spec for an AegisPulse FR (or FR group) in docs/specs/ from PROJECT.md, using the spec template, without adding scope. Invoke as /write-spec FR-XXX-NN.
---

# /write-spec $ARGUMENTS

1. Read the FR text for **$ARGUMENTS** in `PROJECT.md` §2, its §11 checklist block, and every section it implies (§1.4, §5.5, §5.7, §6.2, §6.4, §6.7, §7, §8, the relevant NFRs, and the ADRs).
2. Copy `docs/specs/_template.md` to `docs/specs/$ARGUMENTS-<kebab-title>.md`, matching the grouping used in the §11 `####` heading.
3. Fill in every section from `PROJECT.md` only:
   - §1 quotes the FR verbatim.
   - §2 has the full behavior, including alternate and forbidden paths (validation, role × tenant, duplicate/idempotent, conflict, dependency failure, replay).
   - §3 lists tables, indexes, and migration file names, plus RLS and grants.
   - §4 lists action names (§6.2), routes (§8.3), error codes (§8.4), and events (§6.7) with schema paths.
   - §5 places every piece per `docs/steering/structure.md`.
   - §6 covers authz, limits, redaction, and the logs, spans, and metrics required by NFR-07.
   - §7 has the test table, with names that include the FR id.
   - §8 lists the runtime acceptance commands to run later.
4. Ambiguity rule: if `PROJECT.md` doesn't answer something the spec needs, **don't guess**. List it under a final "Open questions" heading and recommend an amendment (`/amend-project`).
5. Set status to `PENDING`, or keep the existing verified status if you're updating.
6. Report the spec path and any open questions.
