package io.aegispulse.registry.it;

import static org.assertj.core.api.Assertions.assertThat;

import io.aegispulse.registry.service.ServiceAccountService;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;

/** FR-AUTH-04, FR-TEN-06/07, ADR-0017: client credentials and service accounts. */
class ClientCredentialsIT extends RegistryIt {
  @Autowired ServiceAccountService serviceAccounts;
  @Autowired JdbcClient jdbc;

  @AfterEach
  void resetClock() {
    CLOCK.reset();
  }

  Reply token(String clientId, String secret, String audience) {
    return post(
        "issueClientCredentialsToken",
        null,
        Map.of("clientId", clientId, "clientSecret", secret, "audience", audience));
  }

  @Test
  void FR_TEN_07_gatewayServiceTokenCarriesItsExactAllowlist() throws Exception {
    Reply r = token("svc-gateway", GATEWAY_SECRET, "aegispulse-internal");
    assertThat(r.status()).isEqualTo(200);
    assertThat(r.data().has("refreshToken")).isFalse();
    var c = jwt(r.data().get("accessToken").asString()).getJWTClaimsSet();
    assertThat(c.getStringClaim("typ")).isEqualTo("service");
    assertThat(c.getAudience()).containsExactly("aegispulse-internal");
    assertThat(c.getSubject()).isEqualTo("svc-gateway");
    assertThat(c.getStringListClaim("act"))
        .containsExactly(
            "registry.login", "registry.refreshToken", "ingestion.ingestWebhookDelivery");
    assertThat(c.getClaim("tid")).isNull();
    Reply me = post("getCurrentPrincipal", r.data().get("accessToken").asString(), Map.of());
    assertThat(me.status()).isEqualTo(403); // not in svc-gateway's act[]
    assertThat(token("svc-gateway", GATEWAY_SECRET, "aegispulse").code())
        .isEqualTo("AUTH_INVALID_CREDENTIALS"); // SERVICE must ask for the internal audience
  }

  @Test
  void FR_AUTH_04_wrongSecretsAreUniformThenRateLimited() {
    for (int i = 0; i < 10; i++) {
      Reply bad = token("svc-files", "wrong-" + i, "aegispulse-internal");
      assertThat(bad.status()).isEqualTo(401);
      assertThat(bad.code()).isEqualTo("AUTH_INVALID_CREDENTIALS");
    }
    assertThat(token("svc-files", "wrong", "aegispulse-internal").status()).isEqualTo(429);
    Reply unknown = token("svc-nope", "x", "aegispulse-internal");
    assertThat(unknown.status()).isEqualTo(401);
    assertThat(unknown.body().path("error").path("message").asString())
        .isEqualTo("invalid client credentials");
  }

  @Test
  void FR_TEN_07_secretReconciliationRotatesInWithA24hGrace() {
    String s1 = Infra.secret();
    String s2 = Infra.secret();
    assertThat(serviceAccounts.reconcile("svc-orchestrator", s1))
        .isEqualTo(ServiceAccountService.Reconciled.ROTATED_IN);
    assertThat(serviceAccounts.reconcile("svc-orchestrator", s1))
        .isEqualTo(ServiceAccountService.Reconciled.UNCHANGED);
    assertThat(serviceAccounts.reconcile("svc-data-intel", null))
        .isEqualTo(ServiceAccountService.Reconciled.MISSING);
    assertThat(token("svc-orchestrator", s1, "aegispulse-internal").status()).isEqualTo(200);

    assertThat(serviceAccounts.reconcile("svc-orchestrator", s2))
        .isEqualTo(ServiceAccountService.Reconciled.ROTATED_IN);
    assertThat(token("svc-orchestrator", s1, "aegispulse-internal").status()).isEqualTo(200);
    assertThat(token("svc-orchestrator", s2, "aegispulse-internal").status()).isEqualTo(200);
    CLOCK.advance(Duration.ofHours(24).plusMinutes(1));
    assertThat(token("svc-orchestrator", s1, "aegispulse-internal").status()).isEqualTo(401);
    assertThat(token("svc-orchestrator", s2, "aegispulse-internal").status()).isEqualTo(200);
  }

  @Test
  void FR_TEN_06_integrationAccountLifecycle() {
    UUID tenant = createTenant("sa-life-it");
    UUID admin = createFirstAdmin(tenant, "admin@sa-life-it.example");
    String ta = Tokens.user(admin, tenant, "sa-life-it", "TENANT_ADMIN");

    Reply created =
        post("createServiceAccount", ta, Map.of("name", "ERP feed"), "Idempotency-Key", "sa-1");
    assertThat(created.status()).isEqualTo(201);
    String id = created.data().get("id").asString();
    String clientId = created.data().get("clientId").asString();
    String secret1 = created.data().get("clientSecret").asString();
    assertThat(clientId).startsWith("int_");
    assertThat(secret1).matches("^[A-Za-z0-9_-]{43}$");
    Reply again =
        post("createServiceAccount", ta, Map.of("name", "ERP feed"), "Idempotency-Key", "sa-1");
    assertThat(again.status()).isEqualTo(409); // a one-time secret is never replayed
    assertThat(again.code()).isEqualTo("IDEMPOTENCY_KEY_REUSED");

    Reply t1 = token(clientId, secret1, "aegispulse");
    assertThat(t1.status()).isEqualTo(200);
    Map<String, Object> c = claims(t1.data().get("accessToken").asString());
    assertThat(c)
        .containsEntry("typ", "integration")
        .containsEntry("tid", tenant.toString())
        .containsEntry("tslug", "sa-life-it")
        .containsEntry("roles", List.of("INTEGRATION"));
    Reply me = post("getCurrentPrincipal", t1.data().get("accessToken").asString(), Map.of());
    assertThat(me.data().get("typ").asString()).isEqualTo("integration");
    assertThat(me.data().get("id").asString()).isEqualTo(id);
    assertThat(token(clientId, secret1, "aegispulse-internal").status()).isEqualTo(401);

    Reply rotated = post("rotateServiceAccountSecret", ta, Map.of("serviceAccountId", id));
    String secret2 = rotated.data().get("clientSecret").asString();
    assertThat(rotated.data().get("previousSecretValidUntil").isNull()).isFalse();
    assertThat(token(clientId, secret1, "aegispulse").status()).isEqualTo(200); // grace
    CLOCK.advance(Duration.ofHours(24).plusMinutes(1));
    assertThat(token(clientId, secret1, "aegispulse").status()).isEqualTo(401);
    assertThat(token(clientId, secret2, "aegispulse").status()).isEqualTo(200);
    CLOCK.reset();

    Reply revoked = post("revokeServiceAccount", ta, Map.of("serviceAccountId", id));
    assertThat(revoked.data().get("status").asString()).isEqualTo("REVOKED");
    assertThat(token(clientId, secret2, "aegispulse").status()).isEqualTo(401);
    Reply list = post("listServiceAccounts", ta, Map.of());
    assertThat(list.data())
        .singleElement()
        .satisfies(a -> assertThat(a.has("clientSecret")).isFalse());

    assertThat(
            awaitEvents(
                e ->
                    e.eventType().equals("registry.service_account.changed")
                        && id.equals(e.payload().get("serviceAccountId")),
                3))
        .extracting(e -> e.payload().get("changedFields"))
        .containsExactlyInAnyOrder(List.of("created"), List.of("secret"), List.of("status"));
    assertThat(
            jdbc.sql(
                    "SELECT count(*) FROM registry.client_credentials_lookup(?) WHERE secret_hash LIKE '$argon2id$%'")
                .param(clientId)
                .query(Long.class)
                .single())
        .isEqualTo(2);
  }

  @Test
  void FR_AUTH_06_otherTenantsAccountsAreNotFoundAndSuspendedTenantsGetNoTokens() {
    UUID a = createTenant("sa-iso-a-it");
    UUID b = createTenant("sa-iso-b-it");
    String taA =
        Tokens.user(
            createFirstAdmin(a, "admin@sa-iso-a.example"), a, "sa-iso-a-it", "TENANT_ADMIN");
    String taB =
        Tokens.user(
            createFirstAdmin(b, "admin@sa-iso-b.example"), b, "sa-iso-b-it", "TENANT_ADMIN");
    Reply created = post("createServiceAccount", taA, Map.of("name", "feed"));
    String id = created.data().get("id").asString();
    assertThat(post("rotateServiceAccountSecret", taB, Map.of("serviceAccountId", id)).status())
        .isEqualTo(404);
    assertThat(post("revokeServiceAccount", taB, Map.of("serviceAccountId", id)).status())
        .isEqualTo(404);

    post(
        "updateTenantStatus",
        paToken(),
        Map.of("tenantId", a, "status", "SUSPENDED", "reason", "hold"));
    Reply suspended =
        token(
            created.data().get("clientId").asString(),
            created.data().get("clientSecret").asString(),
            "aegispulse");
    assertThat(suspended.code()).isEqualTo("TENANT_SUSPENDED");
  }
}
