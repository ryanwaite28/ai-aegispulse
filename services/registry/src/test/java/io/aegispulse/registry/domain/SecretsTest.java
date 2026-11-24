package io.aegispulse.registry.domain;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class SecretsTest {
  @Test
  void FR_AUTH_02_tokensAreBase64urlAndHashesHex() {
    assertThat(Secrets.randomToken(32)).matches("^[A-Za-z0-9_-]{43}$");
    assertThat(Secrets.randomToken(32)).isNotEqualTo(Secrets.randomToken(32));
    assertThat(Secrets.sha256Hex("abc"))
        .isEqualTo("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  }
}
