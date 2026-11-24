package io.aegispulse.registry;

import java.util.Base64;

/**
 * Test helper: RFC 7468 PEM text for DER bytes generated at runtime (no key material is ever stored
 * in the repo).
 */
public final class Pem {
  private Pem() {}

  public static String encode(String label, byte[] der, String newline) {
    String body =
        Base64.getMimeEncoder(64, newline.getBytes(java.nio.charset.StandardCharsets.US_ASCII))
            .encodeToString(der);
    return "-----BEGIN "
        + label
        + "-----"
        + newline
        + body
        + newline
        + "-----END "
        + label
        + "-----"
        + newline;
  }

  public static String pkcs8(byte[] der) {
    return encode("PRIVATE KEY", der, "\n");
  }
}
