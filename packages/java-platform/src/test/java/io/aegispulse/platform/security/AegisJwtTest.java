package io.aegispulse.platform.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.nimbusds.jose.jwk.source.ImmutableJWKSet;
import io.aegispulse.platform.config.AegisPlatformProperties;
import io.aegispulse.platform.errors.DomainException;
import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;

/** FR-AUTH-05 / §5.7.4 token rules. */
class AegisJwtTest {
  private static final JwtFixtures KEYS = new JwtFixtures();
  private static final AegisPlatformProperties.Security CONFIG =
      new AegisPlatformProperties.Security(
          URI.create("http://registry/.well-known/jwks.json"),
          JwtFixtures.ISSUER,
          "aegispulse",
          "aegispulse-internal",
          Duration.ofSeconds(60),
          List.of());
  private static final JwtDecoder DECODER =
      AegisJwt.decoder(CONFIG, new ImmutableJWKSet<>(KEYS.publicJwks()));
  private static final String TENANT = UUID.randomUUID().toString();

  private static AegisAuthentication authenticate(String token) {
    return (AegisAuthentication) AegisJwt.converter().convert(DECODER.decode(token));
  }

  @Test
  void userTokenMapsToUserPrincipal() {
    AegisAuthentication auth =
        authenticate(KEYS.sign(JwtFixtures.userClaims(TENANT), "aegispulse", "u-1"));
    assertThat(auth.getPrincipal())
        .isInstanceOfSatisfying(
            AegisPrincipal.User.class,
            u -> {
              assertThat(u.tenantId()).isEqualTo(TENANT);
              assertThat(u.hasAnyRole("TENANT_ADMIN", "ANALYST")).isTrue();
            });
    assertThat(auth.getAuthorities()).extracting(Object::toString).containsExactly("ROLE_ANALYST");
  }

  @Test
  void rejectsWrongAudienceIssuerKeyAlgAndExpiry() {
    Map<String, Object> user = JwtFixtures.userClaims(TENANT);
    assertThatThrownBy(() -> DECODER.decode(KEYS.sign(user, "aegispulse-dev", "u-1")))
        .isInstanceOf(JwtException.class);
    assertThatThrownBy(() ->
            DECODER.decode(
                KEYS.sign(
                    user, "aegispulse", "u-1", Instant.now().plusSeconds(900), KEYS.foreignKey)))
        .isInstanceOf(JwtException.class);
    assertThatThrownBy(() -> DECODER.decode(KEYS.signHs256(user, "aegispulse")))
        .isInstanceOf(JwtException.class);
    assertThatThrownBy(() ->
            DECODER.decode(
                KEYS.sign(user, "aegispulse", "u-1", Instant.now().minusSeconds(120), KEYS.key)))
        .isInstanceOf(JwtException.class);
    // inside the 60 s leeway
    assertThat(
            DECODER.decode(
                KEYS.sign(user, "aegispulse", "u-1", Instant.now().minusSeconds(30), KEYS.key)))
        .isNotNull();
    // user token missing roles
    assertThatThrownBy(() ->
            DECODER.decode(
                KEYS.sign(Map.of("typ", "user", "tid", TENANT, "tslug", "a"), "aegispulse", "u-1")))
        .isInstanceOf(JwtException.class);
  }

  @Test
  void integrationTokensAreTenantPrincipalsWithOnlyTheIntegrationRole_FR_AUTH_04() {
    Map<String, Object> integration =
        Map.of(
            "typ", "integration", "tid", TENANT, "tslug", "acme", "roles", List.of("INTEGRATION"));
    AegisAuthentication auth = authenticate(KEYS.sign(integration, "aegispulse", "cli_123"));
    assertThat(auth.getPrincipal())
        .isInstanceOfSatisfying(
            AegisPrincipal.Integration.class,
            p -> {
              assertThat(p.clientId()).isEqualTo("cli_123");
              assertThat(p.tenantId()).isEqualTo(TENANT);
            });
    Map<String, Object> escalated =
        Map.of(
            "typ", "integration", "tid", TENANT, "tslug", "acme", "roles", List.of("TENANT_ADMIN"));
    assertThatThrownBy(() -> DECODER.decode(KEYS.sign(escalated, "aegispulse", "cli_123")))
        .isInstanceOf(JwtException.class);
  }

  @Test
  void typMustBeKnownAndMatchItsAudience_FR_TEN_07() {
    Map<String, Object> noTyp = Map.of("tid", TENANT, "tslug", "acme", "roles", List.of("ANALYST"));
    assertThatThrownBy(() -> DECODER.decode(KEYS.sign(noTyp, "aegispulse", "u-1")))
        .isInstanceOf(JwtException.class);
    Map<String, Object> service = Map.of("typ", "service", "act", List.of("cases.openCase"));
    assertThatThrownBy(() -> DECODER.decode(KEYS.sign(service, "aegispulse", "svc-x")))
        .isInstanceOf(JwtException.class); // service token on the public audience
    Map<String, Object> actNoTyp = Map.of("act", List.of("cases.openCase"));
    assertThatThrownBy(() -> DECODER.decode(KEYS.sign(actNoTyp, "aegispulse-internal", "svc-x")))
        .isInstanceOf(JwtException.class); // internal token without typ=service
  }

  @Test
  void serviceTokensNeedInternalAudienceAndAct() {
    String svc =
        KEYS.sign(
            Map.of("typ", "service", "act", List.of("cases.recordRiskEvaluation")),
            "aegispulse-internal",
            "svc-orchestrator");
    AegisAuthentication auth = authenticate(svc);
    assertThat(auth.getPrincipal())
        .isEqualTo(
            new AegisPrincipal.Service("svc-orchestrator", List.of("cases.recordRiskEvaluation")));

    ServiceActionAuthorizer authorizer = new ServiceActionAuthorizer();
    assertThat(authorizer.requireAction(auth, "cases.recordRiskEvaluation"))
        .isInstanceOf(AegisPrincipal.Service.class);
    assertThatThrownBy(() -> authorizer.requireAction(auth, "cases.openCase"))
        .isInstanceOfSatisfying(
            DomainException.Forbidden.class, f -> assertThat(f.code()).isEqualTo("FORBIDDEN"));
    assertThatThrownBy(() -> authorizer.requireAction(null, "x"))
        .isInstanceOf(DomainException.Unauthorized.class);

    // a user token minted for the internal audience is not accepted
    assertThatThrownBy(() ->
            DECODER.decode(KEYS.sign(JwtFixtures.userClaims(TENANT), "aegispulse-internal", "u-1")))
        .isInstanceOf(JwtException.class);
    // service token without act[]
    assertThatThrownBy(() ->
            DECODER.decode(KEYS.sign(Map.of("typ", "service"), "aegispulse-internal", "svc-x")))
        .isInstanceOf(JwtException.class);
    // user principals pass the action gate (RBAC + tenant checks belong to the service layer)
    assertThat(
            authorizer.requireAction(
                authenticate(KEYS.sign(JwtFixtures.userClaims(TENANT), "aegispulse", "u-1")),
                "cases.openCase"))
        .isInstanceOf(AegisPrincipal.User.class);
  }
}
