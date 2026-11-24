package io.aegispulse.registry.it;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import java.util.UUID;

/** Test-only RS256 signer for §2.2 tokens; the key is generated per JVM and never persisted. */
@SuppressWarnings("JavaUtilDate")
final class Tokens {
  static final String ISSUER = "aegispulse-registry";
  static final RSAKey KEY;

  static {
    try {
      KEY = new RSAKeyGenerator(2048).keyID("it-1").generate();
    } catch (JOSEException e) {
      throw new IllegalStateException(e);
    }
  }

  private Tokens() {}

  static JWKSet publicJwks() {
    return new JWKSet(KEY.toPublicJWK());
  }

  static String user(UUID userId, UUID tenantId, String slug, String... roles) {
    return sign(
        new JWTClaimsSet.Builder()
            .audience("aegispulse")
            .subject(userId.toString())
            .claim("typ", "user")
            .claim("tid", tenantId.toString())
            .claim("tslug", slug)
            .claim("roles", List.of(roles))
            .build());
  }

  static String service(String clientId, String... actions) {
    return sign(
        new JWTClaimsSet.Builder()
            .audience("aegispulse-internal")
            .subject(clientId)
            .claim("typ", "service")
            .claim("act", List.of(actions))
            .build());
  }

  private static String sign(JWTClaimsSet claims) {
    Instant now = Instant.now();
    JWTClaimsSet full =
        new JWTClaimsSet.Builder(claims)
            .issuer(ISSUER)
            .jwtID(UUID.randomUUID().toString())
            .issueTime(Date.from(now))
            .expirationTime(Date.from(now.plusSeconds(900)))
            .build();
    try {
      SignedJWT jwt =
          new SignedJWT(
              new JWSHeader.Builder(JWSAlgorithm.RS256)
                  .keyID(KEY.getKeyID())
                  .type(JOSEObjectType.JWT)
                  .build(),
              full);
      jwt.sign(new RSASSASigner(KEY));
      return jwt.serialize();
    } catch (JOSEException e) {
      throw new IllegalStateException(e);
    }
  }
}
