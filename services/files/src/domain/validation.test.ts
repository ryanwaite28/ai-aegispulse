import { describe, expect, it } from "vitest";
import { decide, sniff, typeMatches } from "./validation.js";

const b = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("type sniffing (FR-FILE-05)", () => {
  it("recognises PDF by magic and binaries by signature", () => {
    expect(sniff(b("%PDF-1.7\n..."), false)).toBe("application/pdf");
    expect(sniff(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2]), false)).toBe("binary");
    expect(sniff(Uint8Array.from([0x4d, 0x5a, 0x90, 0]), false)).toBe("binary");
    expect(sniff(Uint8Array.from([0x41, 0x00, 0x42]), false)).toBe("binary"); // NUL
    expect(sniff(Uint8Array.from([0xc3, 0x28]), false)).toBe("binary"); // invalid UTF-8
  });

  it("classifies text: HTML, JSON, CSV, plain (BOM and leading space tolerated)", () => {
    expect(sniff(b("<!DOCTYPE html><html>"), false)).toBe("text/html");
    expect(sniff(b(`${String.fromCodePoint(0xfeff)}  {"a":1}`), false)).toBe("application/json");
    expect(sniff(b("[1,2,3]"), false)).toBe("application/json");
    expect(sniff(b("id,amount,currency\n1,10.00,USD\n2,5.00,EUR\n"), false)).toBe("text/csv");
    expect(sniff(b("Quarterly filing notes.\nNo tables here."), false)).toBe("text/plain");
  });

  it("does not misclassify text cut mid-character at the sniff window", () => {
    const head = b("café résumé ".repeat(20)).subarray(0, 25); // may end inside a 2-byte sequence
    expect(sniff(head, true)).toBe("text/plain");
  });

  it("type compatibility: a PDF declared as CSV mismatches; text/plain accepts text-like content", () => {
    expect(typeMatches("text/csv", "application/pdf")).toBe(false);
    expect(typeMatches("text/csv", "text/plain")).toBe(true);
    expect(typeMatches("text/plain", "application/json")).toBe(true);
    expect(typeMatches("text/plain", "binary")).toBe(false);
    expect(typeMatches("application/json", "text/plain")).toBe(false);
  });
});

describe("validation verdict (FR-FILE-05)", () => {
  const declared = { sizeBytes: 10, sha256: "a".repeat(64), contentType: "application/pdf" as const };
  const ok = {
    sizeBytes: 10,
    sha256: "a".repeat(64),
    detected: "application/pdf" as const,
    av: { clean: true, signature: null },
  };

  it("pass → VALIDATED; integrity → FAILED; type → QUARANTINED; malware wins", () => {
    expect(decide(declared, ok)).toEqual({ to: "VALIDATED", reason: null });
    expect(decide(declared, { ...ok, sizeBytes: 11 })).toEqual({ to: "FAILED", reason: "SIZE_MISMATCH" });
    expect(decide(declared, { ...ok, sha256: "b".repeat(64) })).toEqual({ to: "FAILED", reason: "CHECKSUM_MISMATCH" });
    expect(decide(declared, { ...ok, detected: "binary" })).toEqual({
      to: "QUARANTINED",
      reason: "TYPE_MISMATCH:binary",
    });
    expect(decide(declared, { ...ok, sizeBytes: 11, av: { clean: false, signature: "Eicar-Signature" } })).toEqual({
      to: "QUARANTINED",
      reason: "MALWARE:Eicar-Signature",
    });
    expect(decide(declared, { ...ok, av: null })).toEqual({ to: "VALIDATED", reason: null });
  });
});
