package io.aegispulse.platform.security;

import static org.assertj.core.api.Assertions.assertThat;

import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.sun.net.httpserver.HttpServer;
import io.aegispulse.platform.config.AegisPlatformProperties;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.jwt.JwtDecoder;

/** FR-AUTH-05: JWKS cached, refetched immediately for an unknown kid (key rotation). */
class JwksRotationTest {
  @Test
  void FR_AUTH_05_unknownKidTriggersRefetchWithinCacheWindow() throws Exception {
    JwtFixtures fixtures = new JwtFixtures();
    RSAKey next = new RSAKeyGenerator(2048).keyID("k2").generate();
    AtomicReference<JWKSet> served = new AtomicReference<>(fixtures.publicJwks());
    AtomicInteger fetches = new AtomicInteger();
    HttpServer server =
        HttpServer.create(new InetSocketAddress(java.net.InetAddress.getLoopbackAddress(), 0), 0);
    server.createContext(
        "/.well-known/jwks.json",
        ex -> {
          fetches.incrementAndGet();
          byte[] body = served.get().toString().getBytes(StandardCharsets.UTF_8);
          ex.getResponseHeaders().add("Content-Type", "application/json");
          ex.sendResponseHeaders(200, body.length);
          ex.getResponseBody().write(body);
          ex.close();
        });
    server.start();
    try {
      URI uri =
          URI.create(
              "http://127.0.0.1:" + server.getAddress().getPort() + "/.well-known/jwks.json");
      JwtDecoder decoder =
          AegisJwt.decoder(
              new AegisPlatformProperties.Security(
                  uri,
                  JwtFixtures.ISSUER,
                  "aegispulse",
                  "aegispulse-internal",
                  Duration.ofSeconds(60),
                  List.of()));
      String tenant = UUID.randomUUID().toString();
      Instant exp = Instant.now().plusSeconds(900);
      assertThat(
              decoder.decode(
                  fixtures.sign(
                      JwtFixtures.userClaims(tenant), "aegispulse", "u", exp, fixtures.key)))
          .isNotNull();
      assertThat(
              decoder.decode(
                  fixtures.sign(
                      JwtFixtures.userClaims(tenant), "aegispulse", "u", exp, fixtures.key)))
          .isNotNull();
      assertThat(fetches.get()).isEqualTo(1); // cached

      // Rotation: the registry now publishes k2 (current) + k1 (previous).
      served.set(new JWKSet(List.of(next.toPublicJWK(), fixtures.key.toPublicJWK())));
      assertThat(
              decoder.decode(
                  fixtures.sign(JwtFixtures.userClaims(tenant), "aegispulse", "u", exp, next)))
          .isNotNull();
      assertThat(fetches.get()).isEqualTo(2); // refetched on the unknown kid, not after 10 min
      assertThat(
              decoder.decode(
                  fixtures.sign(
                      JwtFixtures.userClaims(tenant), "aegispulse", "u", exp, fixtures.key)))
          .isNotNull(); // previous key still accepted
    } finally {
      server.stop(0);
    }
  }
}
