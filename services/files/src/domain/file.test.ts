import { describe, expect, it } from "vitest";
import {
  canTransition,
  checkContentType,
  checkPartList,
  MAX_SINGLE_PUT_BYTES,
  MULTIPART_PART_BYTES,
  partSizes,
  rawObjectKey,
  sanitizeFilename,
  uploadMode,
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
    expect(uploadMode(MAX_SINGLE_PUT_BYTES, false)).toBe("single");
    expect(code(() => uploadMode(MAX_SINGLE_PUT_BYTES + 1, false))).toBe("FILE_TOO_LARGE");
    expect(uploadMode(MAX_SINGLE_PUT_BYTES + 1, true)).toBe("multipart");
    expect(code(() => uploadMode(512 * 1024 * 1024 + 1, true))).toBe("FILE_TOO_LARGE");
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

describe("download Content-Disposition (FR-FILE-08)", () => {
  it("is an attachment with an ASCII fallback and an RFC 5987 UTF-8 name; never breaks out of the quotes", async () => {
    const { attachmentDisposition } = await import("./file.js");
    expect(attachmentDisposition("report.pdf")).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    expect(attachmentDisposition('Résumé "Q3".pdf')).toBe(
      `attachment; filename="R_sum_ _Q3_.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22Q3%22.pdf`,
    );
    expect(attachmentDisposition("../../etc/passwd")).toContain('filename="passwd"');
  });
});

describe("multipart parts (FR-FILE-13)", () => {
  it("splits into 16 MiB parts with the remainder last, ≤ 32 parts at 512 MiB", () => {
    expect(partSizes(200 * 1024 * 1024)).toEqual([...Array<number>(12).fill(MULTIPART_PART_BYTES), 8 * 1024 * 1024]);
    expect(partSizes(512 * 1024 * 1024)).toHaveLength(32);
  });

  it("requires exactly parts 1..n, each once, with an ETag", () => {
    const parts = [1, 2, 3].map((n) => ({ partNumber: n, etag: `"e${String(n)}"` }));
    expect(code(() => checkPartList(parts, 3))).toBe("ok");
    expect(code(() => checkPartList([...parts].reverse(), 3))).toBe("ok");
    expect(code(() => checkPartList(parts.slice(0, 2), 3))).toBe("VALIDATION_ERROR");
    expect(code(() => checkPartList([...parts, { partNumber: 3, etag: "x" }], 3))).toBe("VALIDATION_ERROR");
    expect(code(() => checkPartList([{ partNumber: 1, etag: "" }], 1))).toBe("VALIDATION_ERROR");
  });
});
