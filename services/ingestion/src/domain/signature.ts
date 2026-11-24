// FR-WHK-02 webhook signatures. Signed string = `{timestamp}.{deliveryId}.{rawBody}` over the raw bytes (before any
// JSON parsing); HMAC-SHA256 with the CURRENT and (unexpired) PREVIOUS secret. Every candidate × secret pair is
// compared with crypto.timingSafeEqual on equal-length 32-byte buffers; there is no early exit, so timing does not
// reveal which pair matched or how many candidates were sent. Pure: no I/O.
import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_SIGNATURES = 5;
export const MAX_SKEW_SECONDS = 300;
const SIGNATURE = /^v1=([0-9a-f]{64})$/;
const DELIVERY_ID = /^[\x21-\x7e]{1,128}$/;
const TIMESTAMP = /^[0-9]{1,12}$/;

export interface SignedHeaders {
  readonly signatures: readonly Buffer[];
  readonly timestamp: number;
  readonly deliveryId: string;
}

export type HeaderCheck = { ok: true; headers: SignedHeaders } | { ok: false; reason: "signature" };

/** Parses the three headers; anything absent or malformed is a signature failure (FR-WHK-03: 401, never 400). */
export function parseHeaders(raw: {
  signature?: string | undefined;
  timestamp?: string | undefined;
  deliveryId?: string | undefined;
}): HeaderCheck {
  if (raw.signature === undefined || raw.timestamp === undefined || raw.deliveryId === undefined) {
    return { ok: false, reason: "signature" };
  }
  if (!TIMESTAMP.test(raw.timestamp) || !DELIVERY_ID.test(raw.deliveryId)) return { ok: false, reason: "signature" };
  const parts = raw.signature.split(",").map((p) => p.trim());
  if (parts.length === 0 || parts.length > MAX_SIGNATURES) return { ok: false, reason: "signature" };
  const signatures: Buffer[] = [];
  for (const part of parts) {
    const m = SIGNATURE.exec(part);
    if (m?.[1] === undefined) return { ok: false, reason: "signature" };
    signatures.push(Buffer.from(m[1], "hex"));
  }
  return { ok: true, headers: { signatures, timestamp: Number(raw.timestamp), deliveryId: raw.deliveryId } };
}

export function signedString(timestamp: number | string, deliveryId: string, rawBody: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${String(timestamp)}.${deliveryId}.`, "utf8"), rawBody]);
}

export function hmac(secret: string, message: Buffer): Buffer {
  return createHmac("sha256", secret).update(message).digest();
}

/** The `X-Aegis-Signature` value a sender computes (used by scripts/demo/webhook-sign.ts and tests). */
export function sign(secret: string, timestamp: number | string, deliveryId: string, rawBody: Buffer): string {
  return `v1=${hmac(secret, signedString(timestamp, deliveryId, rawBody)).toString("hex")}`;
}

export interface Candidate<S extends string> {
  readonly slot: S;
  readonly secret: string;
}

/**
 * Returns the slot of the first secret that matches any provided signature, or undefined. All pairs are compared
 * (constant work for a given header and secret count). `compare` is injectable so tests can prove the path used.
 */
export function verify<S extends string>(
  headers: SignedHeaders,
  rawBody: Buffer,
  secrets: readonly Candidate<S>[],
  compare: (a: Buffer, b: Buffer) => boolean = timingSafeEqual,
): S | undefined {
  const message = signedString(headers.timestamp, headers.deliveryId, rawBody);
  let matched: S | undefined;
  for (const candidate of secrets) {
    const expected = hmac(candidate.secret, message);
    for (const provided of headers.signatures) {
      const equal = provided.length === expected.length && compare(provided, expected);
      if (equal && matched === undefined) matched = candidate.slot;
    }
  }
  return matched;
}

export function withinSkew(timestamp: number, nowMs: number): boolean {
  return Math.abs(nowMs / 1000 - timestamp) <= MAX_SKEW_SECONDS;
}
