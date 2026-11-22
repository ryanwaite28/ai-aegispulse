# Phase NN — <Name> — Exit Evidence

| | |
|---|---|
| Commit SHA | `<sha>` |
| Date (UTC) | YYYY-MM-DD HH:MM |
| Environment(s) | local · homelab |
| Pipeline | <GitLab pipeline URL> |
| Verified by | <name / agent + human reviewer> |
| Resulting status | INTEGRATION-VERIFIED / RUNTIME-VERIFIED |

## FR coverage
| FR | Spec | Tests (names) | Status |
|---|---|---|---|
| FR-… | docs/specs/… | … | … |

## Runtime Completion Gate (PROJECT.md §11.0)
- [ ] 1. Source + migrations merged; contracts regenerated with no diff. Evidence:
- [ ] 2. Clean-state startup (`make reset && make up && make migrate`), `/readyz` 200. Evidence:
- [ ] 3. Real dependencies in integration and E2E. Evidence:
- [ ] 4. Async: outbox publish, 3× redelivery idempotency, retry → DLQ. Evidence:
- [ ] 5. Security checks for this phase. Evidence:
- [ ] 6. Logs, traces, and metrics visible; alerts defined. Evidence:
- [ ] 7. UI flows (Playwright), if any. Evidence:

## Commands & output
```text
$ <command>
<real output>
```

## Endpoints / messages exercised
| Interface | Request / routing key | Result |
|---|---|---|

## Known gaps / follow-ups
- …
