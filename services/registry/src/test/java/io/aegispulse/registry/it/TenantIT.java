package io.aegispulse.registry.it;

import static org.assertj.core.api.Assertions.assertThat;

import io.aegispulse.contracts.envelope.CanonicalEnvelope;
import io.aegispulse.registry.domain.PlatformTenant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** FR-TEN-01/02/03 over the internal API with real PostgreSQL (RLS) and RabbitMQ. */
class TenantIT extends RegistryIt {

  @Test
  void FR_TEN_01_createsActiveTenantWithDefaultsAndPublishesEvent() {
    Reply r =
        post(
            "createTenant",
            paToken(),
            Map.of(
                "slug", "acme-capital-it",
                "displayName", "ACME Capital",
                "highRiskCountries", List.of("RU", "IR", "RU")),
            "Idempotency-Key",
            "k-acme-1");
    assertThat(r.status()).isEqualTo(201);
    assertThat(r.data().get("status").asString()).isEqualTo("ACTIVE");
    assertThat(r.data().get("highValueThresholdUsd").asString()).isEqualTo("50000");
    assertThat(r.data().get("retentionDays").asInt()).isEqualTo(400);
    assertThat(r.data().get("demoMode").asBoolean()).isFalse();
    assertThat(r.data().get("highRiskCountries").toString()).isEqualTo("[\"IR\",\"RU\"]");
    assertThat(r.body().get("meta").get("correlationId").asString()).startsWith("corr-");
    String tenantId = r.data().get("id").asString();

    List<CanonicalEnvelope> events =
        awaitEvents(
            e -> e.eventType().equals("registry.tenant.created") && tenantId.equals(e.tenantId()),
            1);
    assertThat(events).hasSize(1);
    CanonicalEnvelope e = events.getFirst();
    assertThat(e.payload())
        .containsEntry("tenantId", tenantId)
        .containsEntry("slug", "acme-capital-it");
    assertThat(e.payload().get("actorId")).isEqualTo(PLATFORM_ADMIN_ID.toString());
    assertThat(e.producer()).startsWith("aegispulse-registry@");
  }

  @Test
  void FR_TEN_01_idempotentReplayAndKeyReuse() {
    Map<String, Object> body = Map.of("slug", "idem-tenant-it", "displayName", "Idem");
    Reply first = post("createTenant", paToken(), body, "Idempotency-Key", "k-idem");
    Reply replay = post("createTenant", paToken(), body, "Idempotency-Key", "k-idem");
    assertThat(first.status()).isEqualTo(201);
    assertThat(replay.status()).isEqualTo(201);
    assertThat(replay.data().get("id")).isEqualTo(first.data().get("id"));

    Reply reused =
        post(
            "createTenant",
            paToken(),
            Map.of("slug", "other-tenant-it", "displayName", "Other"),
            "Idempotency-Key",
            "k-idem");
    assertThat(reused.status()).isEqualTo(409);
    assertThat(reused.code()).isEqualTo("IDEMPOTENCY_KEY_REUSED");
  }

  @Test
  void FR_TEN_01_duplicateAndReservedSlugsConflict() {
    createTenant("dup-slug-it");
    Reply dup =
        post(
            "createTenant",
            paToken(),
            Map.of("slug", "dup-slug-it", "displayName", "Again"),
            "Idempotency-Key",
            "k-dup-2");
    assertThat(dup.status()).isEqualTo(409);
    assertThat(dup.code()).isEqualTo("TENANT_SLUG_TAKEN");

    Reply reserved =
        post(
            "createTenant",
            paToken(),
            Map.of("slug", PlatformTenant.SLUG, "displayName", "Nope"),
            "Idempotency-Key",
            "k-platform");
    assertThat(reserved.status()).isEqualTo(409);
    assertThat(reserved.code()).isEqualTo("TENANT_SLUG_TAKEN");
  }

  @Test
  void FR_TEN_01_requiresPlatformAdminUserTokenAndIdempotencyKey() {
    Map<String, Object> body = Map.of("slug", "authz-it", "displayName", "Authz");
    assertThat(post("createTenant", null, body, "Idempotency-Key", "a").status()).isEqualTo(401);
    String ta = Tokens.user(UUID.randomUUID(), UUID.randomUUID(), "x", "TENANT_ADMIN");
    assertThat(post("createTenant", ta, body, "Idempotency-Key", "a").status()).isEqualTo(403);
    String svc = Tokens.service("svc-cases", "registry.createTenant");
    Reply asService = post("createTenant", svc, body, "Idempotency-Key", "a");
    assertThat(asService.status()).isEqualTo(403);
    Reply noKey = post("createTenant", paToken(), body);
    assertThat(noKey.status()).isEqualTo(422);
    assertThat(noKey.code()).isEqualTo("VALIDATION_ERROR");
    Reply badSlug =
        post(
            "createTenant",
            paToken(),
            Map.of("slug", "No_Caps", "displayName", "x"),
            "Idempotency-Key",
            "b");
    assertThat(badSlug.status()).isEqualTo(422);
  }

  @Test
  void FR_TEN_02_03_suspendRestoreDeactivate() {
    UUID id = createTenant("lifecycle-it");
    Reply suspended =
        post(
            "updateTenantStatus",
            paToken(),
            Map.of("tenantId", id, "status", "SUSPENDED", "reason", "billing hold"));
    assertThat(suspended.status()).isEqualTo(200);
    assertThat(suspended.data().get("status").asString()).isEqualTo("SUSPENDED");
    assertThat(suspended.data().get("statusReason").asString()).isEqualTo("billing hold");

    Reply again =
        post(
            "updateTenantStatus",
            paToken(),
            Map.of("tenantId", id, "status", "SUSPENDED", "reason", "again"));
    assertThat(again.status()).isEqualTo(409);

    assertThat(
            post(
                    "updateTenantStatus",
                    paToken(),
                    Map.of("tenantId", id, "status", "ACTIVE", "reason", "paid"))
                .status())
        .isEqualTo(200);
    assertThat(
            post(
                    "updateTenantStatus",
                    paToken(),
                    Map.of("tenantId", id, "status", "DEACTIVATED", "reason", "closed"))
                .status())
        .isEqualTo(200);
    Reply afterTerminal =
        post(
            "updateTenantStatus",
            paToken(),
            Map.of("tenantId", id, "status", "ACTIVE", "reason", "reopen"));
    assertThat(afterTerminal.status()).isEqualTo(409);

    String tid = id.toString();
    assertThat(
            awaitEvents(
                e -> e.eventType().equals("registry.tenant.suspended") && tid.equals(e.tenantId()),
                1))
        .singleElement()
        .satisfies(e -> assertThat(e.payload()).containsEntry("reason", "billing hold"));
    assertThat(
            awaitEvents(
                e -> e.eventType().equals("registry.tenant.restored") && tid.equals(e.tenantId()),
                1))
        .hasSize(1);
    assertThat(
            awaitEvents(
                e ->
                    e.eventType().equals("registry.tenant.deactivated") && tid.equals(e.tenantId()),
                1))
        .singleElement()
        .satisfies(e -> assertThat(e.payload()).containsEntry("reason", "closed"));
  }

  @Test
  void FR_TEN_09_platformTenantAndUnknownTenantsAreNotManageable() {
    Reply platform =
        post(
            "updateTenantStatus",
            paToken(),
            Map.of("tenantId", PlatformTenant.ID, "status", "SUSPENDED", "reason", "x"));
    assertThat(platform.status()).isEqualTo(404);
    Reply unknown =
        post(
            "updateTenantStatus",
            paToken(),
            Map.of("tenantId", UUID.randomUUID(), "status", "SUSPENDED", "reason", "x"));
    assertThat(unknown.status()).isEqualTo(404);
  }

  @Test
  void FR_TEN_08_settingsReadAndUpdateWithOwnershipAndEvent() {
    UUID tenant = createTenant("settings-it");
    UUID admin = createFirstAdmin(tenant, "admin@settings-it.example");
    String ta = Tokens.user(admin, tenant, "settings-it", "TENANT_ADMIN");
    Reply read = post("getTenantSettings", ta, Map.of("tenantId", tenant));
    assertThat(read.status()).isEqualTo(200);
    assertThat(read.data().get("highValueThresholdUsd").asString()).isEqualTo("50000");

    Reply updated =
        post(
            "updateTenantSettings",
            ta,
            Map.of(
                "tenantId",
                tenant,
                "highValueThresholdUsd",
                "75000.50",
                "highRiskCountries",
                List.of("KP", "IR"),
                "retentionDays",
                400));
    assertThat(updated.status()).isEqualTo(200);
    assertThat(updated.data().get("highValueThresholdUsd").asString()).isEqualTo("75000.5");
    assertThat(updated.data().get("highRiskCountries").toString()).isEqualTo("[\"IR\",\"KP\"]");
    String tid = tenant.toString();
    assertThat(
            awaitEvents(
                e ->
                    e.eventType().equals("registry.tenant.settings_changed")
                        && tid.equals(e.tenantId()),
                1))
        .singleElement()
        .satisfies(e ->
            assertThat(e.payload().get("changedFields"))
                .isEqualTo(List.of("highValueThresholdUsd", "highRiskCountries")));

    // Service callers with the act[] entry read any tenant (FR-TEN-08); others are denied.
    String svc = Tokens.service("svc-files", "registry.getTenantSettings");
    assertThat(post("getTenantSettings", svc, Map.of("tenantId", tenant)).status()).isEqualTo(200);
    assertThat(
            post("updateTenantSettings", svc, Map.of("tenantId", tenant, "demoMode", true))
                .status())
        .isEqualTo(403);
    // Another tenant's admin sees 404; an analyst is forbidden; the platform tenant is invisible.
    UUID other = createTenant("settings-other-it");
    UUID otherAdmin = createFirstAdmin(other, "admin@settings-other-it.example");
    String taOther = Tokens.user(otherAdmin, other, "settings-other-it", "TENANT_ADMIN");
    assertThat(post("getTenantSettings", taOther, Map.of("tenantId", tenant)).status())
        .isEqualTo(404);
    String analyst = Tokens.user(UUID.randomUUID(), tenant, "settings-it", "ANALYST");
    assertThat(post("getTenantSettings", analyst, Map.of("tenantId", tenant)).status())
        .isEqualTo(403);
    assertThat(post("getTenantSettings", paToken(), Map.of("tenantId", PlatformTenant.ID)).status())
        .isEqualTo(404);
    assertThat(post("updateTenantSettings", ta, Map.of("tenantId", tenant)).status())
        .isEqualTo(422);
  }
}
