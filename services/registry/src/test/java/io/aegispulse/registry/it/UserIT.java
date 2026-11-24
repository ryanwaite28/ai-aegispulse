package io.aegispulse.registry.it;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/** FR-TEN-04/05 (+ FR-AUTH-06 tenant isolation, FR-TEN-09 acting tenant) over the internal API. */
class UserIT extends RegistryIt {
  static final String STRONG = "violet-Harbor-71-quartz!";

  @JsonInclude(JsonInclude.Include.NON_NULL)
  record NewUser(String email, String displayName, List<String> roles, String initialPassword) {}

  String taToken(UUID tenantId, UUID adminId, String slug) {
    return Tokens.user(adminId, tenantId, slug, "TENANT_ADMIN");
  }

  @Test
  void FR_TEN_04_tenantAdminCreatesUsersWithPolicyAndUniqueEmail() {
    UUID tenant = createTenant("users-it");
    UUID admin = createFirstAdmin(tenant, "first.admin@users-it.example");
    String ta = taToken(tenant, admin, "users-it");

    Reply created =
        post(
            "createUser",
            ta,
            new NewUser("Alice@Users-IT.example", "Alice", List.of("ANALYST"), STRONG));
    assertThat(created.status()).isEqualTo(201);
    JsonNode user = created.data();
    assertThat(user.get("email").asString()).isEqualTo("alice@users-it.example");
    assertThat(user.get("mustChangePassword").asBoolean()).isTrue();
    assertThat(user.get("status").asString()).isEqualTo("ACTIVE");
    assertThat(user.has("passwordHash")).isFalse();
    assertThat(created.body().toString()).doesNotContain(STRONG).doesNotContain("argon2");

    Reply dup =
        post(
            "createUser",
            ta,
            new NewUser("ALICE@users-it.example", "Alice 2", List.of("VIEWER"), STRONG));
    assertThat(dup.status()).isEqualTo(409);
    assertThat(dup.code()).isEqualTo("USER_EMAIL_TAKEN");

    Reply weak =
        post(
            "createUser",
            ta,
            new NewUser("bob@users-it.example", "Bob", List.of("VIEWER"), "password123456"));
    assertThat(weak.status()).isEqualTo(422);
    assertThat(weak.code()).isEqualTo("AUTH_PASSWORD_POLICY");
    assertThat(weak.body().toString()).doesNotContain("password123456");

    Reply paRole =
        post(
            "createUser",
            ta,
            new NewUser("eve@users-it.example", "Eve", List.of("PLATFORM_ADMIN"), STRONG));
    assertThat(paRole.status()).isEqualTo(422);

    String userId = user.get("id").asString();
    assertThat(
            awaitEvents(
                e ->
                    e.eventType().equals("registry.user.changed")
                        && userId.equals(e.payload().get("userId")),
                1))
        .singleElement()
        .satisfies(e -> {
          assertThat(e.payload()).containsEntry("actorId", admin.toString());
          assertThat(e.payload()).doesNotContainKey("actingAs");
          assertThat(e.payload().toString()).doesNotContain("alice@");
        });
  }

  @Test
  void FR_TEN_05_listFiltersAndPaginates() {
    UUID tenant = createTenant("list-it");
    UUID admin = createFirstAdmin(tenant, "admin@list-it.example");
    String ta = taToken(tenant, admin, "list-it");
    for (int i = 0; i < 5; i++) {
      assertThat(
              post(
                      "createUser",
                      ta,
                      new NewUser(
                          "u" + i + "@list-it.example", "User " + i, List.of("VIEWER"), STRONG))
                  .status())
          .isEqualTo(201);
    }
    List<String> seen = new ArrayList<>();
    Map<String, Object> q = new HashMap<>(Map.of("limit", 2, "role", "VIEWER"));
    for (int pages = 0; pages < 10; pages++) {
      Reply page = post("listUsers", ta, q);
      assertThat(page.status()).isEqualTo(200);
      page.data().forEach(u -> seen.add(u.get("email").asString()));
      JsonNode next = page.body().get("meta").get("nextCursor");
      if (next == null || next.isNull()) {
        break;
      }
      q.put("cursor", next.asString());
    }
    assertThat(seen)
        .containsExactly(
            "u0@list-it.example",
            "u1@list-it.example",
            "u2@list-it.example",
            "u3@list-it.example",
            "u4@list-it.example");
    Reply admins = post("listUsers", ta, Map.of("role", "TENANT_ADMIN"));
    assertThat(admins.data()).hasSize(1);
    Reply badCursor = post("listUsers", ta, Map.of("cursor", "bm9wZQ"));
    assertThat(badCursor.status()).isEqualTo(422);
  }

  @Test
  void FR_TEN_05_lastTenantAdminIsProtected() {
    UUID tenant = createTenant("lastadmin-it");
    UUID admin = createFirstAdmin(tenant, "admin@lastadmin-it.example");
    String ta = taToken(tenant, admin, "lastadmin-it");

    Reply demote = post("updateUser", ta, Map.of("userId", admin, "roles", List.of("ANALYST")));
    assertThat(demote.status()).isEqualTo(409);
    assertThat(demote.code()).isEqualTo("LAST_TENANT_ADMIN");
    Reply disable = post("updateUser", ta, Map.of("userId", admin, "status", "DISABLED"));
    assertThat(disable.code()).isEqualTo("LAST_TENANT_ADMIN");

    Reply second =
        post(
            "createUser",
            ta,
            new NewUser("second@lastadmin-it.example", "Second", List.of("TENANT_ADMIN"), STRONG));
    UUID secondId = UUID.fromString(second.data().get("id").asString());
    Reply ok =
        post("updateUser", ta, Map.of("userId", admin, "roles", List.of("ANALYST", "VIEWER")));
    assertThat(ok.status()).isEqualTo(200);
    assertThat(ok.data().get("roles").toString()).isEqualTo("[\"ANALYST\",\"VIEWER\"]");

    String ta2 = taToken(tenant, secondId, "lastadmin-it");
    assertThat(post("updateUser", ta2, Map.of("userId", secondId, "status", "DISABLED")).code())
        .isEqualTo("LAST_TENANT_ADMIN");
    Reply rename =
        post("updateUser", ta2, Map.of("userId", secondId, "displayName", "Second Admin"));
    assertThat(rename.status()).isEqualTo(200);
    String sid = secondId.toString();
    assertThat(
            awaitEvents(
                e ->
                    e.eventType().equals("registry.user.changed")
                        && sid.equals(e.payload().get("userId"))
                        && List.of("displayName").equals(e.payload().get("changedFields")),
                1))
        .hasSize(1);
  }

  @Test
  void FR_AUTH_06_crossTenantUsersReadAsNotFound() {
    UUID a = createTenant("iso-a-it");
    UUID b = createTenant("iso-b-it");
    UUID adminA = createFirstAdmin(a, "admin@iso-a.example");
    UUID adminB = createFirstAdmin(b, "admin@iso-b.example");
    String taA = taToken(a, adminA, "iso-a-it");
    Reply touchB = post("updateUser", taA, Map.of("userId", adminB, "displayName", "pwned"));
    assertThat(touchB.status()).isEqualTo(404);
    assertThat(post("listUsers", taA, Map.of()).data())
        .extracting(u -> u.get("id").asString())
        .containsExactly(adminA.toString());
  }

  @Test
  void FR_TEN_09_platformAdminActsOnlyViaXAegisTenant() {
    UUID tenant = createTenant("acting-it");
    Reply noHeader = post("listUsers", paToken(), Map.of());
    assertThat(noHeader.status()).isEqualTo(403);
    Reply platformAsTarget =
        post(
            "listUsers",
            paToken(),
            Map.of(),
            "X-Aegis-Tenant",
            "00000000-0000-0000-0000-000000000001");
    assertThat(platformAsTarget.status()).isEqualTo(404);
    Reply unknown =
        post("listUsers", paToken(), Map.of(), "X-Aegis-Tenant", UUID.randomUUID().toString());
    assertThat(unknown.status()).isEqualTo(404);

    UUID admin = createFirstAdmin(tenant, "admin@acting-it.example");
    String aid = admin.toString();
    assertThat(
            awaitEvents(
                e ->
                    e.eventType().equals("registry.user.changed")
                        && aid.equals(e.payload().get("userId")),
                1))
        .singleElement()
        .satisfies(e -> assertThat(e.payload()).containsEntry("actingAs", "PLATFORM_ADMIN"));

    String ta = taToken(tenant, admin, "acting-it");
    Reply taWithHeader = post("listUsers", ta, Map.of(), "X-Aegis-Tenant", tenant.toString());
    assertThat(taWithHeader.status()).isEqualTo(403);
    String analyst = Tokens.user(UUID.randomUUID(), tenant, "acting-it", "ANALYST");
    assertThat(post("listUsers", analyst, Map.of()).status()).isEqualTo(403);
  }
}
