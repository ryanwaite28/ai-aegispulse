# rxjs-rabbitmq 3.0.0 — adoption review (Phase 1, slice 1b)

- **Date:** 2026-11-23
- **Package:** `rxjs-rabbitmq@3.0.0`. Published 2026-11-23T03:20:09Z, dist-tag `latest`, npm provenance (SLSA v1) verified with `npm audit signatures`.
- **Reviewed against:** the temporary upgrade brief's requirements R1–R9 (deleted on adoption; each requirement is summarised in the table below).
- **Verdict:** **ACCEPTED** and adopted in `packages/ts-platform/amqp` on 2026-11-23. The owner chose to install it inside the pnpm minimum-release-age window via a single-version `minimumReleaseAgeExclude` entry ([phase-01b](phase-01b.md)).

## Source review (packed tarball, `src/` and `dist/`)
| Req | Result | Notes |
|---|---|---|
| R1 topology modes | ✅ | `topology: 'declare' \| 'verify' \| 'none'`. `'verify'` uses passive `checkQueue`/`checkExchange` and skips bindings, and fails with `TopologyVerificationError` (no retry). **Library default is `'declare'`; the AegisPulse kit must always pass `'verify'`.** |
| R2 confirms | ✅ | Separate confirm publish channel (default `confirm: true`). `PublishNackedError`, `PublishReturnedError` (correlated by `messageId`; auto-generated for mandatory), and `PublishChannelClosedError`. Waits for `drain` under backpressure. Before ready, a publish waits `readyTimeoutMs` and then rejects; nothing is buffered without bound. |
| R3 bounded streams | ✅ | `Subject`, not `ReplaySubject`. Lazy `basic.consume` on first subscriber. Delivery records are in a `WeakMap`. Unhandled deliveries default to `nack-requeue`. |
| R4 stable subscriptions | ✅ | Per-queue runtimes are created once and survive reconnects. `establish()` re-consumes every queue that still has subscribers. |
| R5 lifecycle | ✅ | `idle → connecting → ready → reconnecting → closing → closed`, exposed as `state`/`state$`. `stopConsuming`/`startConsuming`. `close({ drainTimeoutMs })` cancels consumers, then drains in-flight deliveries, handler promises and pending confirms. `onFailure()` ignores `closing`/`closed`, and `init()` after close rejects. |
| R6 channel resilience | ✅ | Channel `error`/`close` and server `basic.cancel` are handled; a stale ack is a no-op, so no 406. Exponential backoff with jitter. `errors$` event union. |
| R7 republish | ✅ | `event.republish()` / `client.republish()`: confirm-publish the copy (mandatory by default, `userId` dropped), then ack. On failure, nack-requeue and rethrow. The deprecated helpers now copy before ack. |
| R8 deps/typing | ✅ | Peer dependencies `amqplib ^2.4.0` and `rxjs ^7.8.2`; `uuid` dropped; Node ≥ 20. Dual ESM/CJS `exports`; the ESM entry wraps CJS, so there is one module instance. No `any` in the published `.d.ts`. |
| R9 hooks/metrics | ✅ | `hooks.onPublish(properties, target)` and `hooks.onDeliver(event)`. `event.queue` and `event.consumerTag`. Counters `publishConfirmed`, `publishNacked`, `publishReturned` and `channelRecreated`. |

## Independent runtime check (isolated scratch project, not the repo)
Setup: npm install outside the repo of `rxjs-rabbitmq@3.0.0`, `amqplib@2.4.0`, `rxjs@7.8.2` and `typescript@6.0.3`. The consumer was type-checked with `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and `verbatimModuleSyntax`, with **`skipLibCheck: false`**, and passed. It ran on Node 24.22.3 against `rabbitmq:4.4.1-management-alpine` (the compose pin). The restricted user had permissions configure `^$`, write `^(app\.ex|app\.retry)$`, read `^(app\.q|app\.q\.retry\.1s)$`.

```
PASS  R1 declare mode refused without configure perm (sanity)
PASS  R1 verify rejects missing queue with TopologyVerificationError naming it
PASS  R1 verify-mode init under configure ^$  (ready)
PASS  R2 confirmed publish resolves and is consumed (event.queue set)
PASS  R2 unroutable mandatory rejects with PublishReturnedError
PASS  R2 publish to forbidden/missing exchange rejects (PublishChannelClosedError)
PASS  R6 publish channel recovered; consumer unaffected
PASS  R2 1000 concurrent confirmed publishes resolve  (1000/1000 in 31ms)
PASS  R2 all 1000 consumed
PASS  R7 republish: copy in retry queue, original acked  (app.q ready/unacked=0/0 retry ready=1)
PASS  R5/R6 state left ready on connection loss  (state after kill=reconnecting)
PASS  R4 same subscription receives after forced reconnect  (rabbitmqctl close_all_connections)
PASS  R5 close() reaches closed
PASS  R5 no reconnect within 5s after close  (connections=0)
PASS  R5 init() after close rejects
15/15 checks passed
```

**Not re-run here.** These rely on the library's own CI, and its output was not handed back:
- the SIGKILL-between-receive-and-republish test;
- the 100k-message heap test;
- server cancel on queue deletion;
- `stopConsuming` broker confirmation.

## Notes for the AegisPulse kit (`ts-platform/amqp`)
- Always set `topology: 'verify'`, `confirm: true` and `unhandledMessages: 'nack-requeue'` explicitly. Don't rely on library defaults.
- With a restricted user, RabbitMQ answers a passive check of a **missing** queue with `403 ACCESS_REFUSED (configure)`, not `404`. The `TopologyVerificationError` still names the resource; readiness logs should surface `cause`.
- Every `publishEvent`/`republish` promise must be awaited or handled, because an unhandled rejection terminates the process.
- Delays stay in broker TTL queues (§5.5). Never use the deprecated `retryMessage({ delayMs })`.

## Cosmetic (reported to owner; non-blocking)
The packaged `CHANGELOG.md` heading still reads `## 3.0.0 (unreleased)`.
