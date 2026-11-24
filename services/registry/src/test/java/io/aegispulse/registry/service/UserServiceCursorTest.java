package io.aegispulse.registry.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.aegispulse.platform.errors.DomainException;
import java.time.OffsetDateTime;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class UserServiceCursorTest {
  @Test
  void FR_TEN_05_cursorRoundTripsAndRejectsGarbage() {
    OffsetDateTime at = OffsetDateTime.parse("2026-11-23T10:15:30.123456Z");
    UUID id = UUID.randomUUID();
    String cursor = UserService.encodeCursor(at, id);
    assertThat(cursor).matches("^[A-Za-z0-9_-]+$");
    var position = UserService.decodeCursor(cursor);
    assertThat(position.createdAt()).isEqualTo(at);
    assertThat(position.id()).isEqualTo(id);
    assertThatThrownBy(() -> UserService.decodeCursor("bm9wZQ"))
        .isInstanceOf(DomainException.Validation.class);
  }

  @Test
  void producerFallsBackToZeroShaOutsideImages() {
    assertThat(RegistryEvents.producer("registry", "dev")).isEqualTo("aegispulse-registry@0000000");
    assertThat(RegistryEvents.producer("registry", "abc1234"))
        .isEqualTo("aegispulse-registry@abc1234");
  }
}
