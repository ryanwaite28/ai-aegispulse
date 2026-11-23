package io.aegispulse.platform.security;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Test-only RS256 signer + JWKS (keys generated per run; nothing persisted). Nimbus claims take
 * java.util.Date.
 */
@SuppressWarnings("JavaUtilDate")
public final class JwtFixtures {
  public static final String ISSUER = "aegispulse-registry";
  public final RSAKey key;
  public final RSAKey foreignKey;

  public JwtFixtures() {
    try {
      key = new RSAKeyGenerator(2048).keyID("k1").generate();
      foreignKey = new RSAKeyGenerator(2048).keyID("k1").generate();
    } catch (JOSEException e) {
      throw new IllegalStateException(e);
    }
  }

  public JWKSet publicJwks() {
    return new JWKSet(key.toPublicJWK());
  }

  public static Map<String, Object> userClaims(String tenantId) {
    return Map.of("typ", "user", "tid", tenantId, "tslug", "acme", "roles", List.of("ANALYST"));
  }

  public String sign(
      Map<String, Object> claims, String audience, String subject, Instant expiresAt, RSAKey with) {
    JWTClaimsSet.Builder b =
        new JWTClaimsSet.Builder()
            .issuer(ISSUER)
            .audience(audience)
            .subject(subject)
            .jwtID(UUID.randomUUID().toString())
            .issueTime(Date.from(expiresAt.minusSeconds(900)))
            .expirationTime(Date.from(expiresAt));
    claims.forEach(b::claim);
    try {
      SignedJWT jwt =
          new SignedJWT(
              new JWSHeader.Builder(JWSAlgorithm.RS256)
                  .keyID(with.getKeyID())
                  .type(JOSEObjectType.JWT)
                  .build(),
              b.build());
      jwt.sign(new RSASSASigner(with));
      return jwt.serialize();
    } catch (JOSEException e) {
      throw new IllegalStateException(e);
    }
  }

  public String sign(Map<String, Object> claims, String audience, String subject) {
    return sign(claims, audience, subject, Instant.now().plusSeconds(900), key);
  }

  public String signHs256(Map<String, Object> claims, String audience) {
    JWTClaimsSet.Builder b =
        new JWTClaimsSet.Builder()
            .issuer(ISSUER)
            .audience(audience)
            .subject("u-1")
            .expirationTime(Date.from(Instant.now().plusSeconds(900)));
    claims.forEach(b::claim);
    try {
      SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), b.build());
      jwt.sign(new MACSigner("x".repeat(32)));
      return jwt.serialize();
    } catch (JOSEException e) {
      throw new IllegalStateException(e);
    }
  }
}
