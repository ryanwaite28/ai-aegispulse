package io.aegispulse.registry.service;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import io.aegispulse.platform.config.AegisPlatformProperties;
import io.aegispulse.registry.domain.Role;
import io.aegispulse.registry.domain.Tenant;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Collection;
import java.util.Date;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;

/** RS256 access tokens per §2.2 / ADR-0010 (typ user | integration | service; 15 min). */
@Component
@SuppressWarnings("JavaUtilDate") // Nimbus claims take java.util.Date
public class TokenIssuer {
  public static final Duration ACCESS_TTL = Duration.ofMinutes(15);

  private final SigningKeys keys;
  private final Clock clock;
  private final AegisPlatformProperties.Security security;

  public TokenIssuer(SigningKeys keys, Clock clock, AegisPlatformProperties properties) {
    this.keys = keys;
    this.clock = clock;
    this.security = properties.security();
  }

  public String user(UUID userId, Tenant tenant, Collection<Role> roles) {
    return sign(
        new JWTClaimsSet.Builder()
            .audience(security.audience())
            .subject(userId.toString())
            .claim("typ", "user")
            .claim("tid", tenant.id().toString())
            .claim("tslug", tenant.slug())
            .claim("roles", roles.stream().map(Role::name).sorted().toList()));
  }

  public String integration(String clientId, Tenant tenant) {
    return sign(
        new JWTClaimsSet.Builder()
            .audience(security.audience())
            .subject(clientId)
            .claim("typ", "integration")
            .claim("tid", tenant.id().toString())
            .claim("tslug", tenant.slug())
            .claim("roles", List.of("INTEGRATION")));
  }

  public String service(String clientId, List<String> actions) {
    return sign(
        new JWTClaimsSet.Builder()
            .audience(security.internalAudience())
            .subject(clientId)
            .claim("typ", "service")
            .claim("act", List.copyOf(actions)));
  }

  private String sign(JWTClaimsSet.Builder claims) {
    RSAKey key = keys.current();
    Instant now = clock.instant();
    JWTClaimsSet set =
        claims
            .issuer(security.issuer())
            .jwtID(UUID.randomUUID().toString())
            .issueTime(Date.from(now))
            .expirationTime(Date.from(now.plus(ACCESS_TTL)))
            .build();
    try {
      SignedJWT jwt =
          new SignedJWT(
              new JWSHeader.Builder(JWSAlgorithm.RS256)
                  .keyID(key.getKeyID())
                  .type(JOSEObjectType.JWT)
                  .build(),
              set);
      jwt.sign(new RSASSASigner(key));
      return jwt.serialize();
    } catch (JOSEException e) {
      throw new IllegalStateException("token signing failed", e);
    }
  }
}
