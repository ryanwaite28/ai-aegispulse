package io.aegispulse.registry.service;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class PasswordHasherTest {
  private final PasswordHasher hasher = new PasswordHasher();

  @Test
  void FR_TEN_04_argon2idParametersAndRoundTrip() {
    String phc = hasher.hash("violet-Harbor-71-quartz!");
    assertThat(phc).startsWith("$argon2id$v=19$m=65536,t=3,p=1$");
    assertThat(hasher.verify("violet-Harbor-71-quartz!", phc)).isTrue();
    assertThat(hasher.verify("violet-Harbor-71-quartz?", phc)).isFalse();
    assertThat(hasher.hash("violet-Harbor-71-quartz!")).isNotEqualTo(phc); // random salt
  }
}
