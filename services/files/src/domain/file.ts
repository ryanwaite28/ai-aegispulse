// File model and rules (PROJECT.md §2.7, §7.3; FR-FILE-01..04). Pure: no I/O.
import { DomainError } from "@aegispulse/ts-platform/errors";

export const CONTENT_TYPES = ["application/pdf", "text/html", "text/csv", "application/json", "text/plain"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];
export const PURPOSES = ["FILING", "REGULATORY_DOCUMENT", "TRANSACTION_BATCH", "OTHER"] as const;
export type Purpose = (typeof PURPOSES)[number];
export type FileStatus =
  "INITIATED" | "UPLOADED" | "VALIDATED" | "PROCESSING" | "PROCESSED" | "FAILED" | "QUARANTINED" | "EXPIRED";
export type SourceType = "AD_HOC_UPLOAD" | "WEBHOOK_ATTACHMENT" | "CONNECTOR_FETCH";

const MiB = 1024 * 1024;
/** FR-FILE-01: single presigned PUT up to 64 MiB; 64–512 MiB only as multipart (FR-FILE-13, behind a flag). */
export const MAX_SINGLE_PUT_BYTES = 64 * MiB;
export const MAX_MULTIPART_BYTES = 512 * MiB;
/** FR-FILE-03 quotas. */
export const INITS_PER_MINUTE = 60;
export const STORAGE_QUOTA_BYTES = 10 * 1024 * MiB;
/** FR-FILE-01: upload session 15 min (§7.7), presigned PUT 10 min. */
export const UPLOAD_SESSION_TTL_SECONDS = 900;
export const PRESIGNED_PUT_TTL_SECONDS = 600;
/** FR-FILE-02: dedup index 24 h (§7.7). */
export const DEDUP_TTL_SECONDS = 86_400;

/** Statuses that keep a (tenant, sha256) "taken" for dedup (FR-FILE-02). */
export function countsForDedup(status: FileStatus): boolean {
  return status !== "FAILED" && status !== "EXPIRED";
}

/** Legal transitions (§2.7 lifecycle). Anything else is a conflict. */
const TRANSITIONS: Readonly<Record<FileStatus, readonly FileStatus[]>> = {
  INITIATED: ["UPLOADED", "EXPIRED"],
  UPLOADED: ["VALIDATED", "FAILED", "QUARANTINED"],
  VALIDATED: ["PROCESSING"],
  PROCESSING: ["PROCESSED", "FAILED"],
  PROCESSED: [],
  FAILED: [],
  QUARANTINED: [],
  EXPIRED: [],
};

export function canTransition(from: FileStatus, to: FileStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * FR-FILE-01: object key `raw/{tenantId}/{yyyy}/{mm}/{dd}/{fileId}` — built from ids and the clock only, never from
 * the client's filename.
 */
export function rawObjectKey(tenantId: string, fileId: string, at: Date): string {
  return `raw/${tenantId}/${at.toISOString().slice(0, 10).replaceAll("-", "/")}/${fileId}`;
}

/**
 * Display-only filename (defense in depth behind the contract pattern, which already rejects separators, control
 * characters and leading dots): NFC, last path segment, control characters removed, leading dots stripped, ≤ 255.
 */
export function sanitizeFilename(raw: string): string {
  const base = raw.normalize("NFC").split(/[/\\]/).pop() ?? "";
  const printable = [...base].filter((ch) => !isControl(ch)).join("");
  const cleaned = printable.replace(/^\.+/, "").trim().slice(0, 255);
  return cleaned === "" ? "file" : cleaned;
}

/** C0 controls and DEL. */
export function isControl(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return c < 0x20 || c === 0x7f;
}

/** Contract filename rule: no path separators, no control characters, no leading dot. */
export function isAcceptableFilename(name: string): boolean {
  return !name.startsWith(".") && !/[/\\]/.test(name) && ![...name].some(isControl);
}

/** FR-FILE-01 size bounds for a single PUT (multipart arrives with FR-FILE-13). */
export function checkSize(sizeBytes: number, multipartEnabled: boolean): void {
  if (sizeBytes <= MAX_SINGLE_PUT_BYTES) return;
  if (!multipartEnabled || sizeBytes > MAX_MULTIPART_BYTES) {
    throw new DomainError("FILE_TOO_LARGE", "file exceeds the upload size limit", {
      details: [{ field: "sizeBytes", message: `at most ${String(MAX_SINGLE_PUT_BYTES)} bytes per upload` }],
    });
  }
  throw new DomainError("FILE_TOO_LARGE", "multipart uploads are not available yet");
}

export function checkContentType(contentType: string): asserts contentType is ContentType {
  if (!(CONTENT_TYPES as readonly string[]).includes(contentType)) {
    throw new DomainError("FILE_TYPE_NOT_ALLOWED", "content type not allowed", {
      details: [{ field: "contentType", message: `one of ${CONTENT_TYPES.join(", ")}` }],
    });
  }
}

/**
 * FR-FILE-08 `Content-Disposition: attachment` for a sanitized name: an ASCII fallback (quotes, backslashes and
 * non-ASCII replaced) plus RFC 6266/5987 `filename*` with the UTF-8 name percent-encoded.
 */
export function attachmentDisposition(filename: string): string {
  const name = sanitizeFilename(filename);
  const ascii = [...name].map((ch) => (/^[\x20-\x7e]$/.test(ch) && ch !== '"' && ch !== "\\" ? ch : "_")).join("");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
