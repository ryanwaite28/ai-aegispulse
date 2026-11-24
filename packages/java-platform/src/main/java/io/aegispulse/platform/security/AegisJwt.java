package io.aegispulse.platform.security;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.jwk.source.JWKSourceBuilder;
import com.nimbusds.jose.proc.JWSVerificationKeySelector;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jwt.proc.DefaultJWTProcessor;
import io.aegispulse.platform.config.AegisPlatformProperties;
import java.net.MalformedURLException;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import org.jspecify.annotations.Nullable;
import org.springframework.core.convert.converter.Converter;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtIssuerValidator;
import org.springframework.security.oauth2.jwt.JwtTimestampValidator;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;

/**
 * JWT verification (FR-AUTH-01/04/05, FR-TEN-07, §8 "JWT validation note"): RS256 only, kid from
 * the cached registry JWKS, iss, exp/nbf with 60 s leeway, jti required. {@code typ} is exactly one
 * of: user (aud=JWT_AUDIENCE, tid/tslug/roles), integration (aud=JWT_AUDIENCE, tid/tslug,
 * roles=[INTEGRATION]) or service (aud=aegispulse-internal, act[]); any other or missing typ, or a
 * typ on the wrong audience, is rejected.
 */
public final class AegisJwt {
  private AegisJwt() {}

  /** FR-AUTH-05: the JWKS is cached 10 min and refetched at once for an unknown kid. */
  static final long JWKS_TTL_MS = 10 * 60_000L;

  /** Minimum spacing between refetches, so tokens with bogus kids can't hammer the registry. */
  static final long JWKS_REFETCH_COOLDOWN_MS = 5_000L;

  public static JwtDecoder decoder(AegisPlatformProperties.Security config) {
    return decoder(config, remoteJwks(config.jwkSetUri()));
  }

  /** Remote registry JWKS with the FR-AUTH-05 cache rules (refresh on a cache miss). */
  public static JWKSource<SecurityContext> remoteJwks(URI jwkSetUri) {
    try {
      return JWKSourceBuilder.create(jwkSetUri.toURL())
          .cache(JWKS_TTL_MS, 15_000L)
          .rateLimited(JWKS_REFETCH_COOLDOWN_MS)
          .build();
    } catch (MalformedURLException e) {
      throw new IllegalArgumentException("invalid JWKS URI " + jwkSetUri, e);
    }
  }

  /** Decode against a given key source (remote JWKS, or the registry's in-process keys). */
  public static JwtDecoder decoder(
      AegisPlatformProperties.Security config, JWKSource<SecurityContext> keys) {
    DefaultJWTProcessor<SecurityContext> processor = new DefaultJWTProcessor<>();
    processor.setJWSKeySelector(new JWSVerificationKeySelector<>(JWSAlgorithm.RS256, keys));
    processor.setJWSTypeVerifier((header, context) -> {});
    NimbusJwtDecoder decoder = new NimbusJwtDecoder(processor);
    decoder.setJwtValidator(validator(config));
    return decoder;
  }

  static OAuth2TokenValidator<Jwt> validator(AegisPlatformProperties.Security config) {
    return new DelegatingOAuth2TokenValidator<>(
        List.of(
            new JwtTimestampValidator(config.clockSkew()),
            new JwtIssuerValidator(config.issuer()),
            jwt -> audienceAndShape(jwt, config)));
  }

  private static OAuth2TokenValidatorResult invalid(String why) {
    return OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", why, null));
  }

  private static OAuth2TokenValidatorResult audienceAndShape(
      Jwt jwt, AegisPlatformProperties.Security config) {
    List<String> audience = jwt.getAudience();
    List<String> aud = audience == null ? List.of() : audience;
    if (jwt.getId() == null) {
      return invalid("claim jti");
    }
    String typ = jwt.getClaimAsString("typ");
    if ("user".equals(typ) || "integration".equals(typ)) {
      if (!aud.contains(config.audience())) {
        return invalid("audience");
      }
      for (String claim : List.of("tid", "tslug")) {
        if (jwt.getClaimAsString(claim) == null) {
          return invalid("claim " + claim);
        }
      }
      List<String> roles = jwt.getClaimAsStringList("roles");
      if (roles == null) {
        return invalid("claim roles");
      }
      if ("integration".equals(typ) && !roles.equals(List.of("INTEGRATION"))) {
        return invalid("integration roles");
      }
      return OAuth2TokenValidatorResult.success();
    }
    if ("service".equals(typ)) {
      if (!aud.contains(config.internalAudience())) {
        return invalid("audience");
      }
      return jwt.getClaimAsStringList("act") == null
          ? invalid("claim act")
          : OAuth2TokenValidatorResult.success();
    }
    return invalid("typ");
  }

  /** Maps a validated JWT to an {@link AegisAuthentication}. */
  public static Converter<Jwt, AbstractAuthenticationToken> converter() {
    return jwt -> {
      String subject = requireClaim(jwt.getSubject(), "sub");
      String typ = requireClaim(jwt.getClaimAsString("typ"), "typ");
      if ("service".equals(typ)) {
        List<String> actions = requireClaim(jwt.getClaimAsStringList("act"), "act");
        return new AegisAuthentication(
            new AegisPrincipal.Service(subject, List.copyOf(actions)), jwt, List.of());
      }
      List<String> roles = requireClaim(jwt.getClaimAsStringList("roles"), "roles");
      List<SimpleGrantedAuthority> authorities = new ArrayList<>();
      for (String role : roles) {
        authorities.add(new SimpleGrantedAuthority("ROLE_" + role));
      }
      String tenantId = requireClaim(jwt.getClaimAsString("tid"), "tid");
      String tenantSlug = requireClaim(jwt.getClaimAsString("tslug"), "tslug");
      String tokenId = requireClaim(jwt.getId(), "jti");
      AegisPrincipal principal =
          "integration".equals(typ)
              ? new AegisPrincipal.Integration(
                  subject, tenantId, tenantSlug, List.copyOf(roles), tokenId)
              : new AegisPrincipal.User(subject, tenantId, tenantSlug, List.copyOf(roles), tokenId);
      return new AegisAuthentication(principal, jwt, authorities);
    };
  }

  private static <T> T requireClaim(@Nullable T value, String name) {
    if (value == null) {
      throw new org.springframework.security.oauth2.jwt.BadJwtException("missing claim " + name);
    }
    return value;
  }
}
