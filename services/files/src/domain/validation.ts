// FR-FILE-05 validation rules: magic-byte / heuristic type sniffing on the object's first bytes, and the verdict that
// maps measurements to an outcome. Pure: no I/O.
import { isControl, type ContentType } from "./file.js";

const BOM = String.fromCodePoint(0xfeff);

/** Bytes inspected for sniffing (the head of the object). */
export const SNIFF_BYTES = 8 * 1024;

export type DetectedType = "application/pdf" | "text/html" | "application/json" | "text/csv" | "text/plain" | "binary";

const BINARY_MAGIC: readonly number[][] = [
  [0x50, 0x4b, 0x03, 0x04], // zip / office
  [0x4d, 0x5a], // MZ (PE executable)
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x1f, 0x8b], // gzip
  [0xd0, 0xcf, 0x11, 0xe0], // OLE (legacy office)
];

function startsWith(head: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((b, i) => head[i] === b);
}

/** UTF-8 text without NULs or C0 controls other than tab/CR/LF/FF; a sequence cut at the window edge is fine. */
function textOf(head: Uint8Array, truncated: boolean): string | undefined {
  let end = head.length;
  if (truncated) {
    // Drop a trailing partial multi-byte sequence (≤ 3 continuation-incomplete bytes).
    for (let i = 1; i <= 3 && end - i >= 0; i++) {
      const b = head[end - i] ?? 0;
      if ((b & 0xc0) === 0xc0) {
        end -= i;
        break;
      }
      if ((b & 0x80) === 0) break;
    }
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, end));
  } catch {
    return undefined;
  }
  for (const ch of text) if (isControl(ch) && !"\t\n\r\f".includes(ch)) return undefined;
  return text.startsWith(BOM) ? text.slice(1) : text;
}

function looksLikeCsv(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(0, 5);
  if (lines.length === 0) return false;
  const counts = lines.map((l) => (l.match(/,/g) ?? []).length);
  const first = counts[0] ?? 0;
  return first > 0 && counts.every((c) => c === first || c === 0 || Math.abs(c - first) <= 1);
}

/** Sniffs the object head. `truncated` = the object is longer than `head`. */
export function sniff(head: Uint8Array, truncated: boolean): DetectedType {
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (BINARY_MAGIC.some((m) => startsWith(head, m))) return "binary";
  const text = textOf(head, truncated);
  if (text === undefined) return "binary";
  const start = text.trimStart();
  const lower = start.slice(0, 1024).toLowerCase();
  if (lower.startsWith("<!doctype html") || lower.startsWith("<html") || /<(head|body)[\s>]/.test(lower)) {
    return "text/html";
  }
  if (start.startsWith("{") || start.startsWith("[")) return "application/json";
  if (looksLikeCsv(start)) return "text/csv";
  return "text/plain";
}

/** Whether the declared type is consistent with what the bytes are. Text declarations accept text-like content. */
export function typeMatches(declared: ContentType, detected: DetectedType): boolean {
  switch (declared) {
    case "application/pdf":
      return detected === "application/pdf";
    case "text/html":
      return detected === "text/html";
    case "application/json":
      return detected === "application/json";
    case "text/csv":
      return detected === "text/csv" || detected === "text/plain";
    case "text/plain":
      return detected !== "application/pdf" && detected !== "binary";
  }
}

export interface Measurements {
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly detected: DetectedType;
  /** null when AV is disabled (FILES_AV_ENABLED=false). */
  readonly av: { readonly clean: boolean; readonly signature: string | null } | null;
}

export type Verdict =
  | { readonly to: "VALIDATED"; readonly reason: null }
  | { readonly to: "FAILED"; readonly reason: "SIZE_MISMATCH" | "CHECKSUM_MISMATCH" }
  | { readonly to: "QUARANTINED"; readonly reason: string };

/**
 * Malware wins over everything (security first), then integrity (size, checksum → FAILED), then type
 * (mismatch → QUARANTINED). Reasons are short codes, never file contents.
 */
export function decide(
  declared: { sizeBytes: number; sha256: string; contentType: ContentType },
  m: Measurements,
): Verdict {
  if (m.av !== null && !m.av.clean) {
    return { to: "QUARANTINED", reason: `MALWARE:${(m.av.signature ?? "unknown").slice(0, 120)}` };
  }
  if (m.sizeBytes !== declared.sizeBytes) return { to: "FAILED", reason: "SIZE_MISMATCH" };
  if (m.sha256 !== declared.sha256) return { to: "FAILED", reason: "CHECKSUM_MISMATCH" };
  if (!typeMatches(declared.contentType, m.detected)) {
    return { to: "QUARANTINED", reason: `TYPE_MISMATCH:${m.detected}` };
  }
  return { to: "VALIDATED", reason: null };
}
