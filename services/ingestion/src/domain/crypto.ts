// Envelope encryption for webhook signing secrets (FR-WHK-01; spec FR-WHK-01-08 "Secrets at rest").
// A fresh 256-bit data key per secret seals the secret with AES-256-GCM (12-byte nonce; ciphertext ‖ 16-byte tag);
// the data key is wrapped with AES-256 Key Wrap (RFC 3394) under the KEK. Pure: no I/O, no logging of material.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_WRAP_IV = Buffer.from("A6A6A6A6A6A6A6A6", "hex"); // RFC 3394 default IV
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface Kek {
  readonly key: Buffer;
  readonly version: number;
}

export interface SealedSecret {
  readonly ciphertext: Buffer;
  readonly wrappedDataKey: Buffer;
  readonly nonce: Buffer;
  readonly kekVersion: number;
}

/** INGESTION_KEK_BASE64 must decode to exactly 32 bytes (AES-256). */
export function parseKek(base64: string, version: number): Kek {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== base64.trim().replace(/=+$/, "")) {
    throw new Error("INGESTION_KEK_BASE64 must be 32 bytes, base64-encoded");
  }
  return { key, version };
}

export function seal(secret: string, kek: Kek): SealedSecret {
  const dataKey = randomBytes(32);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const ciphertext = Buffer.concat([body, cipher.getAuthTag()]);
  const wrap = createCipheriv("id-aes256-wrap", kek.key, KEY_WRAP_IV);
  const wrappedDataKey = Buffer.concat([wrap.update(dataKey), wrap.final()]);
  dataKey.fill(0);
  return { ciphertext, wrappedDataKey, nonce, kekVersion: kek.version };
}

/** Throws on a wrong KEK/version or any tampering (key-wrap integrity check, GCM tag). */
export function open(sealed: SealedSecret, kek: Kek): string {
  if (sealed.kekVersion !== kek.version) {
    throw new Error(
      `secret sealed with KEK version ${String(sealed.kekVersion)}, process holds ${String(kek.version)}`,
    );
  }
  const unwrap = createDecipheriv("id-aes256-wrap", kek.key, KEY_WRAP_IV);
  const dataKey = Buffer.concat([unwrap.update(sealed.wrappedDataKey), unwrap.final()]);
  try {
    const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES);
    const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", dataKey, sealed.nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } finally {
    dataKey.fill(0);
  }
}

/** 32 random bytes, base64url (FR-WHK-01 signing secret). */
export function newSigningSecret(): string {
  return randomBytes(32).toString("base64url");
}
