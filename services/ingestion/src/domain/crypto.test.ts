import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newSigningSecret, open, parseKek, seal } from "./crypto.js";

const kek = parseKek(randomBytes(32).toString("base64"), 1);

describe("webhook secret envelope encryption (FR-WHK-01)", () => {
  it("round-trips and never stores the secret or data key in clear", () => {
    const secret = newSigningSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const sealed = seal(secret, kek);
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.wrappedDataKey).toHaveLength(40); // 32-byte key + 8-byte AES-KW integrity block
    expect(sealed.ciphertext.includes(Buffer.from(secret))).toBe(false);
    expect(open(sealed, kek)).toBe(secret);
    expect(seal(secret, kek).ciphertext.equals(sealed.ciphertext)).toBe(false); // fresh data key + nonce
  });

  it("rejects tampering with ciphertext, tag, nonce or wrapped key, and a wrong KEK or version", () => {
    const sealed = seal(newSigningSecret(), kek);
    const flip = (b: Buffer, i: number): Buffer => {
      const c = Buffer.from(b);
      c[i] = (c[i] ?? 0) ^ 0x01;
      return c;
    };
    expect(() => open({ ...sealed, ciphertext: flip(sealed.ciphertext, 0) }, kek)).toThrow();
    expect(() => open({ ...sealed, ciphertext: flip(sealed.ciphertext, sealed.ciphertext.length - 1) }, kek)).toThrow();
    expect(() => open({ ...sealed, nonce: flip(sealed.nonce, 3) }, kek)).toThrow();
    expect(() => open({ ...sealed, wrappedDataKey: flip(sealed.wrappedDataKey, 10) }, kek)).toThrow();
    expect(() => open(sealed, parseKek(randomBytes(32).toString("base64"), 1))).toThrow();
    expect(() => open(sealed, { ...kek, version: 2 })).toThrow(/KEK version/);
  });

  it("requires a 32-byte base64 KEK and never echoes it", () => {
    expect(() => parseKek(randomBytes(16).toString("base64"), 1)).toThrow("INGESTION_KEK_BASE64 must be 32 bytes");
    expect(() => parseKek("not base64 at all!!", 1)).toThrow("INGESTION_KEK_BASE64 must be 32 bytes");
  });
});
