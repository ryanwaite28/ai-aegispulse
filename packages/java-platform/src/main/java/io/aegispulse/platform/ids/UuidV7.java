package io.aegispulse.platform.ids;

import java.security.SecureRandom;
import java.time.Clock;
import java.util.UUID;

/**
 * RFC 9562 UUIDv7 (48-bit Unix milliseconds, version 7, variant 10, 74 random bits) for envelope
 * {@code eventId} (§6.4). Time-ordered across milliseconds; random within one.
 */
public final class UuidV7 {
  private static final SecureRandom RANDOM = new SecureRandom();

  private UuidV7() {}

  public static UUID next() {
    return next(Clock.systemUTC());
  }

  public static UUID next(Clock clock) {
    long millis = clock.millis();
    byte[] r = new byte[10];
    RANDOM.nextBytes(r);
    long msb =
        (millis & 0xFFFF_FFFF_FFFFL) << 16 | 0x7000L | ((r[0] & 0x0FL) << 8) | (r[1] & 0xFFL);
    long lsb = 0x8000_0000_0000_0000L | ((r[2] & 0x3FL) << 56);
    for (int i = 3; i < 10; i++) {
      lsb |= (r[i] & 0xFFL) << (8 * (9 - i));
    }
    return new UUID(msb, lsb);
  }
}
