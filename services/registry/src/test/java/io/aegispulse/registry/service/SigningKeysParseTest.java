package io.aegispulse.registry.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.nimbusds.jose.jwk.KeyUse;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import org.junit.jupiter.api.Test;

class SigningKeysParseTest {
  static String pem(RSAKey key, String newline) throws Exception {
    // Real newlines, or the literal two-character "\n" escape some .env files carry.
    return io.aegispulse.registry.Pem.pkcs8(key.toRSAPrivateKey().getEncoded())
        .replace("\n", newline);
  }

  @Test
  void FR_AUTH_05_parsesPkcs8PemIncludingEscapedNewlines() throws Exception {
    RSAKey generated = new RSAKeyGenerator(2048).generate();
    for (String nl : new String[] {"\n", "\\n"}) {
      RSAKey parsed = SigningKeys.parse(pem(generated, nl), "local-2026-11");
      assertThat(parsed.getKeyID()).isEqualTo("local-2026-11");
      assertThat(parsed.getKeyUse()).isEqualTo(KeyUse.SIGNATURE);
      assertThat(parsed.toRSAPublicKey()).isEqualTo(generated.toRSAPublicKey());
      assertThat(parsed.isPrivate()).isTrue();
    }
  }

  @Test
  void FR_AUTH_05_rejectsMissingWeakOrGarbageKeysWithoutEchoingThem() throws Exception {
    assertThatThrownBy(() -> SigningKeys.parse("", "k")).hasMessageContaining("required");
    RSAKey weak = new RSAKeyGenerator(1024, true).generate();
    assertThatThrownBy(() -> SigningKeys.parse(pem(weak, "\n"), "k"))
        .hasMessageContaining("JWT_SIGNING_KEY_CURRENT_PEM");
    assertThatThrownBy(() -> SigningKeys.parse("-----BEGIN PRIVATE KEY-----\nc2VjcmV0\n", "k"))
        .hasMessage("JWT_SIGNING_KEY_CURRENT_PEM is not a PKCS#8 RSA private key");
  }
}
