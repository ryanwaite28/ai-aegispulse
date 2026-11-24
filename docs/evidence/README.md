# Phase Exit Evidence

`PROJECT.md` §11.0 makes evidence a precondition for completion. Each phase gets one file, `phase-NN.md`, created from `_template.md` with `/phase-exit-evidence NN`.

Rules:
- Paste **real** command output. Trim it for length, but never fabricate or "expected" it.
- Always record the commit SHA, date (UTC), environment (`local` / `dev` / `prod`), and who ran it.
- Once a phase is marked `RUNTIME-VERIFIED`, its evidence file is append-only. Add a new dated section for re-verification.
- Screenshots and large logs go in `docs/evidence/assets/phase-NN/`, linked from the file.
