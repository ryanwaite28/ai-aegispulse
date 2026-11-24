// Per-request / per-message context (NFR-07 mandatory fields), propagated with AsyncLocalStorage.
import { AsyncLocalStorage } from "node:async_hooks";

export interface LogContext {
  readonly correlationId?: string;
  readonly tenantId?: string;
  readonly eventId?: string;
  readonly requestId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with `context` merged over the current context. */
export function runWithContext<T>(context: LogContext, fn: () => T): T {
  const current = storage.getStore();
  return storage.run(current === undefined ? context : { ...current, ...context }, fn);
}

export function getContext(): LogContext {
  return storage.getStore() ?? {};
}
