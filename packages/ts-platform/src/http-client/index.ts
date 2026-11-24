// Outbound HTTP client (PROJECT.md §6.5, NFR-10): undici pool per dependency, hard per-call timeout,
// retries only for idempotent calls (max 2, full-jitter exponential from 100 ms), and an opossum circuit breaker
// (open at >= 50% failures once 20 calls are in the rolling window, half-open after 30 s).
// Breaker-open, timeouts, connection errors, 5xx, 408 and 429 surface as TransientError; other 4xx as HttpStatusError.
import { setTimeout as sleep } from "node:timers/promises";
import CircuitBreaker from "opossum";
import { Pool, type Dispatcher } from "undici";
import type { ServiceAction } from "@aegispulse/contracts/generated/ts/service-actions.ts";
import { PermanentError, TransientError, type ErrorCode, type ErrorDetail } from "../errors/index.js";
import { getContext } from "../logging/context.js";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

const IDEMPOTENT_METHODS: ReadonlySet<HttpMethod> = new Set(["GET", "HEAD", "PUT", "DELETE"]);

export interface BreakerOptions {
  readonly errorThresholdPercentage: number;
  readonly volumeThreshold: number;
  readonly resetTimeoutMs: number;
  readonly rollingWindowMs: number;
}

/** §6.5 thresholds. opossum's window is time-based; volumeThreshold = 20 makes it act on at least 20 calls. */
export const DEFAULT_BREAKER: BreakerOptions = {
  errorThresholdPercentage: 50,
  volumeThreshold: 20,
  resetTimeoutMs: 30_000,
  rollingWindowMs: 60_000,
};

export interface HttpClientOptions {
  /** Dependency name, used in errors and breaker events (e.g. "registry"). */
  readonly name: string;
  readonly baseUrl: string;
  /** Per-attempt timeout (§2: scoring 2 s, scanner 10 s, registry 1 s, cases 3 s, events search 3 s). */
  readonly timeoutMs: number;
  /** Retries for idempotent calls. Default 2 (NFR-10). */
  readonly maxRetries?: number;
  readonly retryBaseMs?: number;
  readonly breaker?: Partial<BreakerOptions>;
  readonly connections?: number;
  /** Test hook. */
  readonly dispatcher?: Dispatcher;
}

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Overrides the method default (POST queries that are safe to repeat). */
  readonly idempotent?: boolean;
}

export interface HttpResponse<T> {
  readonly status: number;
  readonly body: T;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * A non-retryable 4xx answer. `code`, `message` and `details` come from the §8.2 error envelope when the body carries
 * one, so the gateway can pass a service's error through unchanged.
 */
export class HttpStatusError extends PermanentError {
  override readonly name = "HttpStatusError";
  readonly status: number;
  readonly dependency: string;
  readonly details: readonly ErrorDetail[];
  constructor(
    dependency: string,
    status: number,
    code: ErrorCode,
    message: string,
    details: readonly ErrorDetail[] = [],
  ) {
    super(code, message);
    this.status = status;
    this.dependency = dependency;
    this.details = details;
  }
}

/**
 * A 429 answer: the dependency is healthy and deliberately throttling (e.g. AUTH_RATE_LIMITED). It is retryable later,
 * never counted by the circuit breaker (a throttled caller must not open the breaker for everyone), and keeps the
 * upstream code and message for pass-through.
 */
export class HttpRateLimitedError extends TransientError {
  override readonly name = "HttpRateLimitedError";
  readonly status = 429;
  readonly dependency: string;
  constructor(dependency: string, code: ErrorCode, message: string) {
    super(code, message);
    this.dependency = dependency;
  }
}

/** A 5xx/408/429 answer (counted by the breaker, retried when idempotent). */
export class HttpUpstreamError extends TransientError {
  override readonly name = "HttpUpstreamError";
  readonly status: number;
  constructor(dependency: string, status: number) {
    super("DEPENDENCY_UNAVAILABLE", `${dependency} answered ${status}`);
    this.status = status;
  }
}

interface EnvelopeError {
  readonly code: ErrorCode;
  readonly message: string | undefined;
  readonly details: readonly ErrorDetail[];
}

/** Reads a §8.2 error envelope; details accept `message` (TS/Python kits) or `issue` (Java kit). */
function envelopeError(body: unknown, status: number): EnvelopeError {
  const error =
    typeof body === "object" && body !== null && "error" in body ? (body as { error: unknown }).error : undefined;
  if (typeof error !== "object" || error === null) return { code: `HTTP_${status}`, message: undefined, details: [] };
  const e = error as { code?: unknown; message?: unknown; details?: unknown };
  const code = typeof e.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(e.code) ? e.code : `HTTP_${status}`;
  const details: ErrorDetail[] = [];
  if (Array.isArray(e.details)) {
    for (const d of e.details as unknown[]) {
      if (typeof d !== "object" || d === null) continue;
      const item = d as { field?: unknown; message?: unknown; issue?: unknown };
      const text = typeof item.message === "string" ? item.message : typeof item.issue === "string" ? item.issue : "";
      details.push(typeof item.field === "string" ? { field: item.field, message: text } : { message: text });
    }
  }
  return { code, message: typeof e.message === "string" ? e.message : undefined, details };
}

function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

export class HttpClient {
  readonly name: string;
  private readonly origin: string;
  private readonly dispatcher: Dispatcher;
  private readonly ownsDispatcher: boolean;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly breaker: CircuitBreaker<[HttpRequest], HttpResponse<unknown>>;

  constructor(options: HttpClientOptions) {
    this.name = options.name;
    this.origin = new URL(options.baseUrl).origin;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseMs = options.retryBaseMs ?? 100;
    this.ownsDispatcher = options.dispatcher === undefined;
    this.dispatcher =
      options.dispatcher ??
      new Pool(options.baseUrl, {
        connections: options.connections ?? 16,
        headersTimeout: options.timeoutMs,
        bodyTimeout: options.timeoutMs,
      });
    const b = { ...DEFAULT_BREAKER, ...options.breaker };
    this.breaker = new CircuitBreaker((req: HttpRequest) => this.attempt(req), {
      name: options.name,
      timeout: false, // the per-attempt AbortSignal owns timeouts
      errorThresholdPercentage: b.errorThresholdPercentage,
      volumeThreshold: b.volumeThreshold,
      resetTimeout: b.resetTimeoutMs,
      rollingCountTimeout: b.rollingWindowMs,
      rollingCountBuckets: 10,
      // A 4xx means the dependency is healthy; it must not open the breaker.
      errorFilter: (error: unknown) => error instanceof HttpStatusError || error instanceof HttpRateLimitedError,
    });
  }

  get breakerState(): "closed" | "open" | "half-open" {
    if (this.breaker.opened) return "open";
    if (this.breaker.halfOpen) return "half-open";
    return "closed";
  }

  async request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    const idempotent = req.idempotent ?? IDEMPOTENT_METHODS.has(req.method);
    const retries = idempotent ? this.maxRetries : 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return (await this.breaker.fire(req)) as HttpResponse<T>;
      } catch (error: unknown) {
        const failure = this.toFailure(error);
        const breakerOpen = failure instanceof TransientError && failure.code === "CIRCUIT_OPEN";
        if (failure instanceof TransientError && !breakerOpen && attempt < retries) {
          // full jitter: uniform in [0, base * 2^attempt]
          await sleep(Math.floor(Math.random() * this.retryBaseMs * 2 ** attempt));
          continue;
        }
        throw failure;
      }
    }
  }

  async close(): Promise<void> {
    this.breaker.shutdown();
    if (this.ownsDispatcher) await this.dispatcher.close();
  }

  private async attempt(req: HttpRequest): Promise<HttpResponse<unknown>> {
    const headers: Record<string, string> = { accept: "application/json", ...req.headers };
    const ctx = getContext();
    if (ctx.correlationId !== undefined && headers["x-correlation-id"] === undefined) {
      headers["x-correlation-id"] = ctx.correlationId;
    }
    let body: string | undefined;
    if (req.body !== undefined) {
      body = JSON.stringify(req.body);
      headers["content-type"] = "application/json";
    }
    const res = await this.dispatcher.request({
      origin: this.origin,
      method: req.method,
      path: req.path,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.body.text();
    let parsed: unknown = text;
    const contentType = res.headers["content-type"];
    if (typeof contentType === "string" && contentType.includes("json") && text.length > 0) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }
    if (res.statusCode === 429) {
      const e = envelopeError(parsed, 429);
      throw new HttpRateLimitedError(this.name, e.code, e.message ?? `${this.name} answered 429`);
    }
    if (isTransientStatus(res.statusCode)) throw new HttpUpstreamError(this.name, res.statusCode);
    if (res.statusCode >= 400) {
      const e = envelopeError(parsed, res.statusCode);
      throw new HttpStatusError(
        this.name,
        res.statusCode,
        e.code,
        e.message ?? `${this.name} answered ${res.statusCode}`,
        e.details,
      );
    }
    return { status: res.statusCode, body: parsed, headers: res.headers };
  }

  private toFailure(error: unknown): Error {
    if (error instanceof HttpStatusError || error instanceof TransientError) return error; // incl. HttpRateLimitedError
    const code = (error as { code?: unknown }).code;
    if (code === "EOPENBREAKER") {
      return new TransientError("CIRCUIT_OPEN", `${this.name} circuit open`, { cause: error });
    }
    const name = error instanceof Error ? error.name : "";
    if (
      name === "TimeoutError" ||
      name === "AbortError" ||
      code === "UND_ERR_HEADERS_TIMEOUT" ||
      code === "UND_ERR_BODY_TIMEOUT"
    ) {
      return new TransientError("DEPENDENCY_UNAVAILABLE", `${this.name} timed out after ${this.timeoutMs}ms`, {
        cause: error,
      });
    }
    return new TransientError("DEPENDENCY_UNAVAILABLE", `${this.name} request failed`, { cause: error });
  }
}

// ── Internal service RPC (PROJECT.md §6.2: POST /internal/v1/{action}) ────────

export type ServiceName = ServiceAction["service"];
export type ActionOf<S extends ServiceName> = Extract<ServiceAction, { service: S }>["action"];
export type PayloadOf<S extends ServiceName, A extends string> = Extract<
  ServiceAction,
  { service: S; action: A }
>["payload"];

export interface InvokeOptions {
  /** Forwarded user token (gateway → service). Otherwise the client's service token is used. */
  readonly authorization?: string;
  /** Queries are safe to retry; commands are not unless they carry an idempotency key. */
  readonly idempotent?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface InternalClientOptions extends HttpClientOptions {
  /** Returns the caller's SERVICE bearer token (see auth/ServiceTokenProvider). */
  readonly serviceToken?: () => Promise<string>;
}

/** §8.2 success envelope as returned by internal actions. */
export interface SuccessEnvelope<R> {
  readonly data: R;
  readonly meta: { readonly requestId?: string; readonly correlationId?: string; readonly nextCursor?: string };
}

/** Typed client for one service's internal actions. Returns the §8.2 `data` member. */
export class InternalServiceClient<S extends ServiceName> {
  private readonly http: HttpClient;
  private readonly serviceToken: (() => Promise<string>) | undefined;

  constructor(
    readonly service: S,
    options: InternalClientOptions,
  ) {
    this.http = new HttpClient(options);
    this.serviceToken = options.serviceToken;
  }

  /** The whole §8.2 success envelope (the gateway needs `meta.nextCursor` from list actions). */
  async invokeEnvelope<A extends ActionOf<S>, R = unknown>(
    action: A,
    payload: PayloadOf<S, A>,
    options: InvokeOptions = {},
  ): Promise<SuccessEnvelope<R>> {
    let authorization = options.authorization;
    if (authorization === undefined && this.serviceToken !== undefined) {
      authorization = `Bearer ${await this.serviceToken()}`;
    }
    const res = await this.http.request<SuccessEnvelope<R>>({
      method: "POST",
      path: `/internal/v1/${action}`,
      body: payload,
      headers: { ...options.headers, ...(authorization === undefined ? {} : { authorization }) },
      ...(options.idempotent === undefined ? {} : { idempotent: options.idempotent }),
    });
    return res.body;
  }

  async invoke<A extends ActionOf<S>, R = unknown>(
    action: A,
    payload: PayloadOf<S, A>,
    options: InvokeOptions = {},
  ): Promise<R> {
    let authorization = options.authorization;
    if (authorization === undefined && this.serviceToken !== undefined) {
      authorization = `Bearer ${await this.serviceToken()}`;
    }
    const res = await this.http.request<{ data: R }>({
      method: "POST",
      path: `/internal/v1/${action}`,
      body: payload,
      headers: { ...options.headers, ...(authorization === undefined ? {} : { authorization }) },
      ...(options.idempotent === undefined ? {} : { idempotent: options.idempotent }),
    });
    return res.body.data;
  }

  get breakerState(): "closed" | "open" | "half-open" {
    return this.http.breakerState;
  }

  close(): Promise<void> {
    return this.http.close();
  }
}
