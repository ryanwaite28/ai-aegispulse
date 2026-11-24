import { describe, expect, it } from "vitest";
import {
  andThen,
  classifyFailure,
  describeError,
  DomainError,
  err,
  fromPromise,
  map,
  mapErr,
  ok,
  PermanentError,
  PoisonMessageError,
  deadLetterMessage,
  stackHash,
  TransientError,
  unwrap,
  unwrapOr,
} from "./index.js";

describe("errors (PROJECT.md §6.8, FR-MSG-01 classification)", () => {
  it("classifies consumer failures per steering/quality.md", () => {
    expect(classifyFailure(new TransientError("DEPENDENCY_UNAVAILABLE", "x"))).toEqual({
      kind: "TRANSIENT",
      code: "DEPENDENCY_UNAVAILABLE",
    });
    expect(classifyFailure(new PermanentError("NOT_FOUND", "x"))).toEqual({ kind: "PERMANENT", code: "NOT_FOUND" });
    expect(classifyFailure(new PoisonMessageError("ENVELOPE_INVALID", "x"))).toEqual({
      kind: "POISON",
      code: "ENVELOPE_INVALID",
    });
    expect(classifyFailure(new DomainError("CONFLICT", "x"))).toEqual({ kind: "PERMANENT", code: "CONFLICT" });
    // unknown errors get the bounded retry budget, then DLQ
    expect(classifyFailure(new Error("boom"))).toEqual({ kind: "TRANSIENT", code: "INTERNAL_ERROR" });
    expect(classifyFailure("string thrown")).toEqual({ kind: "TRANSIENT", code: "INTERNAL_ERROR" });
  });

  it("rejects malformed error codes", () => {
    expect(() => new DomainError("not-a-code", "x")).toThrow(TypeError);
    expect(
      new DomainError("IDEMPOTENCY_KEY_REUSED", "x", { details: [{ field: "k", message: "m" }] }).details,
    ).toHaveLength(1);
  });

  it("describes errors without stacks and bounds the length", () => {
    expect(describeError(new TransientError("DEPENDENCY_UNAVAILABLE", "scanner down"))).toBe(
      "TransientError[DEPENDENCY_UNAVAILABLE]: scanner down",
    );
    expect(describeError(42)).toBe("non-error thrown: number");
    const long = describeError(new Error("x".repeat(2000)), 50);
    expect(long).toHaveLength(50);
    expect(long.endsWith("…")).toBe(true);
  });

  it("hashes the error name + stack frames without line numbers (x-aegis-error-stack-hash, FR-MSG-02)", () => {
    const failAt = (message: string): Error => new PermanentError("NOT_FOUND", message);
    const a = failAt("row 1 missing");
    const b = failAt("row 2 missing");
    expect(stackHash(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(stackHash(a)).toBe(stackHash(b)); // same call site, different message → same group
    const moved = new PermanentError("NOT_FOUND", "x");
    moved.stack = (a.stack ?? "").replace(/:(\d+):(\d+)\)/g, (_m, l: string, c: string) => `:${Number(l) + 7}:${c})`);
    expect(stackHash(moved)).toBe(stackHash(a)); // line shifts do not split the group
    expect(stackHash(new TransientError("NOT_FOUND", "x"))).not.toBe(stackHash(a)); // different error name
    expect(stackHash("thrown string")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("withholds foreign error messages from the DLQ header (FR-MSG-02, no payload values)", () => {
    expect(deadLetterMessage(new PermanentError("NOT_FOUND", "file row missing"))).toBe(
      "PermanentError[NOT_FOUND]: file row missing",
    );
    const foreign = new TypeError('Cannot parse "123-45-6789" as a date');
    expect(deadLetterMessage(foreign)).toBe("TypeError (message withheld)");
    expect(deadLetterMessage("x")).toBe("non-error thrown: string");
  });

  it("composes Results", async () => {
    const r = andThen(
      map(ok(2), (n) => n * 3),
      (n) => (n > 5 ? ok(n) : err(new DomainError("CONFLICT", "small"))),
    );
    expect(unwrap(r)).toBe(6);
    const e = mapErr(err("bad"), (m) => new DomainError("BAD_REQUEST", m));
    expect(unwrapOr(e, 0)).toBe(0);
    expect(() => unwrap(e)).toThrow(DomainError);
    await expect(fromPromise(Promise.reject(new Error("no")), () => "mapped")).resolves.toEqual({
      ok: false,
      error: "mapped",
    });
    await expect(fromPromise(Promise.resolve(1), () => "x")).resolves.toEqual({ ok: true, value: 1 });
  });
});
