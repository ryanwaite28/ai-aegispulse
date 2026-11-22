# Implementation Specs

Each functional requirement in `PROJECT.md` §2 breaks down into one or more implementation specs. A spec file covers one FR, or one FR group that shares a lifecycle, exactly as the `####` headings in `PROJECT.md` §11 group them.

- File name: `FR-{DOMAIN}-{NN}[-{NN}…]-{kebab-title}.md`, e.g. `FR-WHK-02-03-signature-verification.md`.
- Start from `_template.md`. Use `/write-spec FR-XXX-NN` to generate a draft.
- A spec **cannot add scope**. If it needs behavior that `PROJECT.md` doesn't define, amend `PROJECT.md` first (`/amend-project`).
- Keep the spec's status in step with the `PROJECT.md` §11 checklist items it covers.
