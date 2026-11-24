package io.aegispulse.registry.it;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/** FR-AUTH-01/02/03/07 (+ FR-TEN-02/05 effects) with real PostgreSQL, Redis (ACL) and RabbitMQ. */
@SuppressWarnings("JavaUtilDate") // Nimbus claims are java.util.Date
class AuthIT extends RegistryIt {

  @AfterEach
  void resetClock() {
    CLOCK.reset();
  }

  record Session(UUID tenantId, UUID userId, String slug, String email) {}

  Session tenantAdmin(String slug) {
    UUID tenant = createTenant(slug);
    String email = "admin@" + slug + ".example";
    return new Session(tenant, createFirstAdmin(tenant, email), slug, email);
  }

  @Test
  void FR_AUTH_01_loginIssuesSpecTokensThatTheServiceAccepts() throws Exception {
    Session s = tenantAdmin("auth-login-it");
    Reply r = login(s.slug(), "ADMIN@auth-login-it.example", STRONG);
    assertThat(r.status()).isEqualTo(200);
    assertThat(r.data().get("tokenType").asString()).isEqualTo("Bearer");
    assertThat(r.data().get("expiresIn").asInt()).isEqualTo(900);
    assertThat(r.data().get("mustChangePassword").asBoolean()).isTrue();
    String access = r.data().get("accessToken").asString();
    var jwt = jwt(access);
    assertThat(jwt.getHeader().getKeyID()).isEqualTo(Tokens.KEY.getKeyID());
    var c = jwt.getJWTClaimsSet();
    assertThat(c.getSubject()).isEqualTo(s.userId().toString());
    assertThat(c.getAudience()).containsExactly("aegispulse");
    assertThat(c.getIssuer()).isEqualTo("aegispulse-registry");
    assertThat(c.getStringClaim("typ")).isEqualTo("user");
    assertThat(c.getStringClaim("tid")).isEqualTo(s.tenantId().toString());
    assertThat(c.getStringClaim("tslug")).isEqualTo(s.slug());
    assertThat(c.getStringListClaim("roles")).containsExactly("TENANT_ADMIN");
    assertThat(c.getJWTID()).isNotBlank();
    Date iat = c.getIssueTime();
    assertThat(c.getExpirationTime().getTime() - iat.getTime()).isEqualTo(900_000);
    assertThat(r.data().get("refreshToken").asString()).matches("^[A-Za-z0-9_-]{43}$");
    // The registry accepts its own token end to end.
    assertThat(post("listUsers", access, Map.of()).status()).isEqualTo(200);
  }

  @Test
  void FR_AUTH_01_uniformFailuresThenRateLimitedPerTenantAndEmail() {
    Session s = tenantAdmin("auth-ratelimit-it");
    for (int i = 0; i < 5; i++) {
      Reply bad = login(s.slug(), s.email(), "wrong-Password-" + i + "!x");
      assertThat(bad.status()).isEqualTo(401);
      assertThat(bad.code()).isEqualTo("AUTH_INVALID_CREDENTIALS");
    }
    Reply limited = login(s.slug(), s.email(), STRONG); // right password, but throttled
    assertThat(limited.status()).isEqualTo(429);
    assertThat(limited.code()).isEqualTo("AUTH_RATE_LIMITED");

    Reply unknownUser = login(s.slug(), "nobody@auth-ratelimit-it.example", STRONG);
    Reply unknownTenant = login("no-such-tenant-it", s.email(), STRONG);
    assertThat(unknownUser.status()).isEqualTo(401);
    assertThat(unknownTenant.status()).isEqualTo(401);
    assertThat(unknownUser.body().path("error").path("message"))
        .isEqualTo(unknownTenant.body().path("error").path("message"));
  }

  @Test
  void FR_TEN_02_suspendedTenantCannotLoginOrRefresh() {
    Session s = tenantAdmin("auth-suspended-it");
    String refresh = login(s.slug(), s.email(), STRONG).data().get("refreshToken").asString();
    post(
        "updateTenantStatus",
        paToken(),
        Map.of("tenantId", s.tenantId(), "status", "SUSPENDED", "reason", "audit"));
    Reply ok = login(s.slug(), s.email(), STRONG);
    assertThat(ok.status()).isEqualTo(403);
    assertThat(ok.code()).isEqualTo("TENANT_SUSPENDED");
    assertThat(login(s.slug(), s.email(), "wrong-Password-9!x").status()).isEqualTo(401);
    Reply refreshed = post("refreshToken", gatewayToken(), Map.of("refreshToken", refresh));
    assertThat(refreshed.code()).isEqualTo("TENANT_SUSPENDED");
  }

  @Test
  void FR_AUTH_02_refreshRotatesAndReuseRevokesTheFamily() {
    Session s = tenantAdmin("auth-refresh-it");
    String r1 = login(s.slug(), s.email(), STRONG).data().get("refreshToken").asString();
    Reply second = post("refreshToken", gatewayToken(), Map.of("refreshToken", r1));
    assertThat(second.status()).isEqualTo(200);
    String r2 = second.data().get("refreshToken").asString();
    assertThat(r2).isNotEqualTo(r1);

    Reply reuse = post("refreshToken", gatewayToken(), Map.of("refreshToken", r1));
    assertThat(reuse.status()).isEqualTo(401);
    assertThat(reuse.code()).isEqualTo("AUTH_REFRESH_INVALID");
    assertThat(post("refreshToken", gatewayToken(), Map.of("refreshToken", r2)).status())
        .isEqualTo(401); // whole family revoked
    String uid = s.userId().toString();
    assertThat(
            awaitEvents(
                e ->
                    e.eventType().equals("registry.auth.refresh_reuse_detected")
                        && uid.equals(e.payload().get("userId")),
                1))
        .singleElement()
        .satisfies(e -> assertThat(e.payload()).containsKey("familyId"));
  }

  @Test
  void FR_AUTH_02_expiredRefreshIsRejected() {
    Session s = tenantAdmin("auth-expiry-it");
    String r1 = login(s.slug(), s.email(), STRONG).data().get("refreshToken").asString();
    CLOCK.advance(Duration.ofDays(7).plusMinutes(1));
    assertThat(post("refreshToken", gatewayToken(), Map.of("refreshToken", r1)).code())
        .isEqualTo("AUTH_REFRESH_INVALID");
  }

  @Test
  void FR_AUTH_03_meAndLogout() {
    Session s = tenantAdmin("auth-logout-it");
    Reply l = login(s.slug(), s.email(), STRONG);
    String access = l.data().get("accessToken").asString();
    String refresh = l.data().get("refreshToken").asString();
    Reply me = post("getCurrentPrincipal", access, Map.of());
    assertThat(me.data().get("typ").asString()).isEqualTo("user");
    assertThat(me.data().get("email").asString()).isEqualTo(s.email());
    assertThat(me.data().get("roles").toString()).isEqualTo("[\"TENANT_ADMIN\"]");
    assertThat(me.data().get("tenant").get("slug").asString()).isEqualTo(s.slug());
    assertThat(post("logout", access, Map.of("refreshToken", refresh)).status()).isEqualTo(200);
    assertThat(post("refreshToken", gatewayToken(), Map.of("refreshToken", refresh)).status())
        .isEqualTo(401);
    // Someone else's token: silently ignored.
    assertThat(post("logout", access, Map.of("refreshToken", "not-a-token")).status())
        .isEqualTo(200);
  }

  @Test
  void FR_AUTH_07_changePasswordKeepsOnlyTheNamedSession() {
    Session s = tenantAdmin("auth-password-it");
    Reply a = login(s.slug(), s.email(), STRONG);
    Reply b = login(s.slug(), s.email(), STRONG);
    String access = a.data().get("accessToken").asString();
    String keep = a.data().get("refreshToken").asString();
    String other = b.data().get("refreshToken").asString();

    assertThat(
            post(
                    "changePassword",
                    access,
                    Map.of("currentPassword", "wrong-Password-1!x", "newPassword", "x"))
                .code())
        .isEqualTo("AUTH_INVALID_CREDENTIALS");
    assertThat(
            post(
                    "changePassword",
                    access,
                    Map.of("currentPassword", STRONG, "newPassword", "password123456"))
                .code())
        .isEqualTo("AUTH_PASSWORD_POLICY");
    String next = "copper-Lantern-88-meadow?";
    Reply changed =
        post(
            "changePassword",
            access,
            Map.of("currentPassword", STRONG, "newPassword", next, "refreshToken", keep));
    assertThat(changed.status()).isEqualTo(200);
    assertThat(post("refreshToken", gatewayToken(), Map.of("refreshToken", keep)).status())
        .isEqualTo(200);
    assertThat(post("refreshToken", gatewayToken(), Map.of("refreshToken", other)).status())
        .isEqualTo(401);
    assertThat(login(s.slug(), s.email(), STRONG).status()).isEqualTo(401);
    Reply fresh = login(s.slug(), s.email(), next);
    assertThat(fresh.status()).isEqualTo(200);
    assertThat(fresh.data().get("mustChangePassword").asBoolean()).isFalse();
  }

  @Test
  void FR_TEN_05_roleChangeRevokesTheUsersRefreshTokens() {
    Session s = tenantAdmin("auth-rolechange-it");
    String ta = login(s.slug(), s.email(), STRONG).data().get("accessToken").asString();
    Reply analyst =
        post(
            "createUser",
            ta,
            Map.of(
                "email",
                "analyst@auth-rolechange-it.example",
                "displayName",
                "Analyst",
                "roles",
                List.of("ANALYST"),
                "initialPassword",
                STRONG));
    String refresh =
        login(s.slug(), "analyst@auth-rolechange-it.example", STRONG)
            .data()
            .get("refreshToken")
            .asString();
    post(
        "updateUser",
        ta,
        Map.of("userId", analyst.data().get("id").asString(), "roles", List.of("VIEWER")));
    assertThat(post("refreshToken", gatewayToken(), Map.of("refreshToken", refresh)).status())
        .isEqualTo(401);
  }

  @Test
  void FR_AUTH_01_loginRequiresTheGatewayServiceAction() {
    Map<String, Object> body =
        Map.of("tenantSlug", "x-it", "email", "a@b.example", "password", "p");
    assertThat(post("login", null, body).status()).isEqualTo(401);
    assertThat(
            post("login", Tokens.service("svc-files", "registry.getTenantSettings"), body).status())
        .isEqualTo(403);
  }
}
