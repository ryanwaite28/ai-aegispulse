package io.aegispulse.platform.ids;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class UuidV7Test {
  @Test
  void versionVariantAndTimestamp() {
    Instant at = Instant.parse("2026-11-23T12:00:00.123Z");
    UUID id = UuidV7.next(Clock.fixed(at, ZoneOffset.UTC));
    assertThat(id.version()).isEqualTo(7);
    assertThat(id.variant()).isEqualTo(2);
    assertThat(id.getMostSignificantBits() >>> 16).isEqualTo(at.toEpochMilli());
    assertThat(id.toString())
        .matches("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
  }

  @Test
  void orderedAcrossMilliseconds() {
    UUID a = UuidV7.next(Clock.fixed(Instant.ofEpochMilli(1000), ZoneOffset.UTC));
    UUID b = UuidV7.next(Clock.fixed(Instant.ofEpochMilli(1001), ZoneOffset.UTC));
    assertThat(a.toString()).isLessThan(b.toString());
    assertThat(UuidV7.next()).isNotEqualTo(UuidV7.next());
  }
}
