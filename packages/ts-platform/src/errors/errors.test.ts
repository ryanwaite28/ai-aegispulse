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
