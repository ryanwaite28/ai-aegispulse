// Error model (PROJECT.md §6.8): hand-rolled Result type, typed domain errors with stable §8.4 codes,
// and the consumer failure classes used by the AMQP kit (§6.5, steering/quality.md "Error classification").
import { createHash } from "node:crypto";

/** Stable error codes from PROJECT.md §8.4 that the platform itself raises. Services add their own §8.4 codes. */
export type PlatformErrorCode =
  | "VALIDATION_ERROR"
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "DEPENDENCY_UNAVAILABLE"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_KEY_REQUIRED";

/** Any §8.4 code: upper snake case. */
export type ErrorCode = PlatformErrorCode | (string & { readonly __errorCode?: never });

const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export interface ErrorDetail {
  readonly field?: string;
  readonly message: string;
}

/** A business-level failure with a stable code. Never carries secrets or raw input values. */
export class DomainError extends Error {
  override readonly name: string = "DomainError";
  readonly code: ErrorCode;
  readonly details: readonly ErrorDetail[];

  constructor(code: ErrorCode, message: string, options: { details?: readonly ErrorDetail[]; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    if (!CODE_PATTERN.test(code)) {
      throw new TypeError(`invalid error code ${JSON.stringify(code)}`);
    }
    this.code = code;
    this.details = options.details ?? [];
  }
}

/** Retryable failure: timeout, 5xx, circuit open, connection reset, write conflict. Retry tiers, then DLQ. */
export class TransientError extends Error {
  override readonly name: string = "TransientError";
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
  }
}

/** Will never succeed on retry: dependency 4xx (not 408/429), business rule violation. DLQ immediately. */
export class PermanentError extends Error {
  override readonly name: string = "PermanentError";
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
  }
}

/** Undeserializable or schema-invalid message, unknown major schemaVersion. DLQ immediately. */
export class PoisonMessageError extends Error {
  override readonly name: string = "PoisonMessageError";
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
  }
}

export type FailureClass = "TRANSIENT" | "PERMANENT" | "POISON";

export interface ClassifiedFailure {
  readonly kind: FailureClass;
  readonly code: ErrorCode;
}

/**
 * Classifies a consumer failure. Unknown errors are TRANSIENT: a bug gets the bounded retry budget
 * (§NFR-10) and then lands in the DLQ, so nothing is lost or retried forever.
 */
export function classifyFailure(error: unknown): ClassifiedFailure {
  if (error instanceof PoisonMessageError) return { kind: "POISON", code: error.code };
  if (error instanceof PermanentError) return { kind: "PERMANENT", code: error.code };
  if (error instanceof DomainError) return { kind: "PERMANENT", code: error.code };
  if (error instanceof TransientError) return { kind: "TRANSIENT", code: error.code };
  return { kind: "TRANSIENT", code: "INTERNAL_ERROR" };
}

/** A short, log-safe description (name + code + message, no stack, bounded length). */
export function describeError(error: unknown, maxLength = 500): string {
  let text: string;
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    text = `${error.name}${typeof code === "string" || typeof code === "number" ? `[${String(code)}]` : ""}: ${error.message}`;
  } else {
    text = `non-error thrown: ${typeof error}`;
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * The `x-aegis-error-message` value (§6.4, FR-MSG-02): the full log-safe description only for the platform's own
 * error types, whose messages are written by our code and must not embed payload values (steering/quality.md).
 * Any other error (driver, parser, validation library) can carry input values in its message, so only its type
 * travels: "MongoServerError (message withheld)".
 */
export function deadLetterMessage(error: unknown): string {
  if (
    error instanceof DomainError ||
    error instanceof TransientError ||
    error instanceof PermanentError ||
    error instanceof PoisonMessageError
  ) {
    return describeError(error);
  }
  return error instanceof Error ? `${error.name} (message withheld)` : `non-error thrown: ${typeof error}`;
}

/** Stack frames hashed by {@link stackHash}: enough to tell call sites apart, bounded against deep recursion. */
const STACK_HASH_FRAMES = 10;

/**
 * Groups identical failures for the dead-letter registry (§6.4 `x-aegis-error-stack-hash`, FR-MSG-02): first 16 hex
 * of SHA-256 over the error name and its top stack frames with line/column numbers removed, so the same failure
 * hashes the same across builds that only move lines. The message is excluded (it may vary per delivery).
 */
export function stackHash(error: unknown): string {
  let material: string;
  if (error instanceof Error) {
    const frames = (error.stack ?? "")
      .split("\n")
      .filter((line) => /^\s+at\s/.test(line))
      .slice(0, STACK_HASH_FRAMES)
      .map((line) => line.trim().replace(/:\d+(?::\d+)?(?=\)?$)/, ""));
    material = [error.name, ...frames].join("\n");
  } else {
    material = `non-error:${typeof error}`;
  }
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

// ── Result ────────────────────────────────────────────────────────────────────

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}
export type Result<T, E = DomainError> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}
export function andThen<T, U, E>(result: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}
/** Returns the value or throws the error (adapters use this at the transport boundary). */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw result.error;
}
/** Wraps a promise: resolves to ok(value), or err(mapped) when it rejects. */
export async function fromPromise<T, E>(promise: Promise<T>, mapError: (error: unknown) => E): Promise<Result<T, E>> {
  try {
    return ok(await promise);
  } catch (error: unknown) {
    return err(mapError(error));
  }
}
