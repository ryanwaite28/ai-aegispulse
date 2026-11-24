package io.aegispulse.registry.domain;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;

/** Opaque credential material: random base64url tokens and their SHA-256 lookup hashes. */
public final class Secrets {
  private static final SecureRandom RANDOM = new SecureRandom();

  private Secrets() {}

  /**
   * {@code bytes} random bytes, base64url without padding (refresh tokens, client secrets, ids).
   */
  public static String randomToken(int bytes) {
    byte[] b = new byte[bytes];
    RANDOM.nextBytes(b);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
  }

  /** Lower-case hex SHA-256 (refresh-token lookup, throttle key components). */
  public static String sha256Hex(String value) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-256 unavailable", e);
    }
  }
}
