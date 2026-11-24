import { describe, expect, it } from "vitest";
import {
  canTransition,
  checkContentType,
  checkSize,
  MAX_SINGLE_PUT_BYTES,
  rawObjectKey,
  sanitizeFilename,
} from "./file.js";

const T = "8a92269a-91aa-4d80-b6fd-093a350304fe";
const F = "0b6f3c1e-2f4a-4c55-9d2e-6a7b8c9d0e1f";
const code = (f: () => void): string => {
  try {
    f();
    return "ok";
  } catch (e: unknown) {
    return (e as { code: string }).code;
  }
};

describe("file rules (FR-FILE-01)", () => {
  it("builds the object key from ids and the UTC day only", () => {
    expect(rawObjectKey(T, F, new Date("2026-11-24T23:59:59Z"))).toBe(`raw/${T}/2026/11/24/${F}`);
  });

  it("sanitizes display filenames: no path, control chars or leading dots", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("..\\..\\boot.ini")).toBe("boot.ini");
    expect(sanitizeFilename(".hidden\u0000name.pdf")).toBe("hiddenname.pdf");
    expect(sanitizeFilename("...")).toBe("file");
    expect(sanitizeFilename("Résumé Q3.pdf")).toBe("Résumé Q3.pdf");
  });

  it("enforces the type allowlist and the 64 MiB single-PUT bound", () => {
    expect(code(() => checkContentType("application/pdf"))).toBe("ok");
    expect(code(() => checkContentType("application/x-msdownload"))).toBe("FILE_TYPE_NOT_ALLOWED");
    expect(code(() => checkSize(MAX_SINGLE_PUT_BYTES, false))).toBe("ok");
    expect(code(() => checkSize(MAX_SINGLE_PUT_BYTES + 1, false))).toBe("FILE_TOO_LARGE");
  });

  it("allows only the lifecycle transitions", () => {
    expect(canTransition("INITIATED", "UPLOADED")).toBe(true);
    expect(canTransition("INITIATED", "EXPIRED")).toBe(true);
    expect(canTransition("UPLOADED", "INITIATED")).toBe(false);
    expect(canTransition("EXPIRED", "UPLOADED")).toBe(false);
  });
});

describe("filename rule (contract InitUploadInput pattern)", () => {
  it("rejects separators, control characters and leading dots", async () => {
    const { isAcceptableFilename } = await import("./file.js");
    expect(isAcceptableFilename("report.pdf")).toBe(true);
    expect(isAcceptableFilename("Résumé Q3.pdf")).toBe(true);
    for (const bad of ["../../etc/passwd", "a/b.pdf", "a\\b.pdf", ".hidden", "x\u0000y", "tab\there"]) {
      expect(isAcceptableFilename(bad)).toBe(false);
    }
  });
});
