package io.aegispulse.registry.it;

import static org.assertj.core.api.Assertions.assertThat;

import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import io.aegispulse.registry.service.SigningKeys;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;

/** FR-AUTH-05: JWKS endpoint and the key-rotation drill (previous key accepted ≤ 24 h). */
class JwksIT extends RegistryIt {
  @Autowired SigningKeys signingKeys;

  JsonNode jwks() throws Exception {
    HttpResponse<String> r =
        HTTP.send(
            HttpRequest.newBuilder(
                    URI.create("http://localhost:" + port + "/.well-known/jwks.json"))
                .GET()
                .build(),
            HttpResponse.BodyHandlers.ofString());
    assertThat(r.statusCode()).isEqualTo(200);
    assertThat(r.headers().firstValue("Content-Type"))
        .hasValueSatisfying(v -> assertThat(v).startsWith("application/jwk-set+json"));
    assertThat(r.headers().firstValue("Cache-Control"))
        .hasValueSatisfying(v -> assertThat(v).contains("max-age=600"));
    return JSON.readTree(r.body());
  }

  static String pem(RSAKey key) throws Exception {
    return io.aegispulse.registry.Pem.pkcs8(key.toRSAPrivateKey().getEncoded());
  }

  @Test
  void FR_AUTH_05_publishesPublicKeysOnly() throws Exception {
    JsonNode set = jwks();
    assertThat(set.get("keys")).isNotEmpty();
    JsonNode current = set.get("keys").get(0);
    assertThat(current.get("kid").asString()).isEqualTo(Tokens.KEY.getKeyID());
    assertThat(current.get("alg").asString()).isEqualTo("RS256");
    assertThat(current.get("use").asString()).isEqualTo("sig");
    assertThat(current.has("d")).isFalse();
    assertThat(current.has("p")).isFalse();
  }

  @Test
  void FR_AUTH_05_rotationDrill() throws Exception {
    UUID tenant = createTenant("rotation-it");
    UUID admin = createFirstAdmin(tenant, "admin@rotation-it.example");
    String oldToken = Tokens.user(admin, tenant, "rotation-it", "TENANT_ADMIN"); // kid it-1
    RSAKey next = new RSAKeyGenerator(2048).keyID("it-2").generate();
    try {
      signingKeys.register(pem(next), "it-2"); // registry restarted with a new current key
      assertThat(jwks().get("keys"))
          .extracting(k -> k.get("kid").asString())
          .containsExactly("it-2", Tokens.KEY.getKeyID());
      Reply l = login("rotation-it", "admin@rotation-it.example", STRONG);
      assertThat(jwt(l.data().get("accessToken").asString()).getHeader().getKeyID())
          .isEqualTo("it-2");
      assertThat(post("listUsers", l.data().get("accessToken").asString(), Map.of()).status())
          .isEqualTo(200);
      assertThat(post("listUsers", oldToken, Map.of()).status()).isEqualTo(200); // previous key

      CLOCK.advance(Duration.ofHours(24).plusMinutes(1));
      signingKeys.register(pem(next), "it-2"); // next restart retires the previous key
      assertThat(jwks().get("keys"))
          .extracting(k -> k.get("kid").asString())
          .containsExactly("it-2");
      String lateOldToken = Tokens.user(admin, tenant, "rotation-it", "TENANT_ADMIN");
      assertThat(post("listUsers", lateOldToken, Map.of()).status()).isEqualTo(401);
    } finally {
      CLOCK.reset();
      signingKeys.register(Tokens.privatePem(), Tokens.KEY.getKeyID()); // restore for other suites
    }
  }
}
