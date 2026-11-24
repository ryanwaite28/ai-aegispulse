package io.aegispulse.registry.it;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** FR-ENT-01/02 over the internal API (real PostgreSQL with pg_trgm, RLS). */
class EntityIT extends RegistryIt {

  Reply createEntity(String token, Map<String, Object> body) {
    return post("createEntity", token, body);
  }

  @Test
  void FR_ENT_01_createDuplicateAndEvent() {
    Team t = team("ent-create-it");
    Reply acme =
        createEntity(
            t.analyst(),
            Map.of(
                "name", "ACME Holdings, Inc.",
                "entityType", "ORGANIZATION",
                "ticker", "ACMH",
                "country", "US",
                "aliases", List.of("Acme Capital", "ACME")));
    assertThat(acme.status()).isEqualTo(201);
    assertThat(acme.data().get("normalizedName").asString()).isEqualTo("acme");
    assertThat(acme.data().get("aliases").toString()).isEqualTo("[\"ACME\",\"Acme Capital\"]");
    String id = acme.data().get("id").asString();

    Reply dup = createEntity(t.ta(), Map.of("name", "Acme Corp.", "entityType", "ORGANIZATION"));
    assertThat(dup.status()).isEqualTo(409);
    assertThat(dup.code()).isEqualTo("ENTITY_DUPLICATE");
    Reply aliasDup =
        createEntity(
            t.ta(),
            Map.of(
                "name",
                "Other Co",
                "entityType",
                "ORGANIZATION",
                "aliases",
                List.of("acme capital")));
    assertThat(aliasDup.code()).isEqualTo("ENTITY_DUPLICATE");
    assertThat(createEntity(t.viewer(), Map.of("name", "X", "entityType", "PERSON")).status())
        .isEqualTo(403);
    assertThat(createEntity(t.ta(), Map.of("name", "...", "entityType", "PERSON")).status())
        .isEqualTo(422);

    assertThat(
            awaitEvents(
                e ->
                    e.eventType().equals("registry.entity.changed")
                        && id.equals(e.payload().get("entityId")),
                1))
        .singleElement()
        .satisfies(e -> assertThat(e.payload().get("changedFields")).isEqualTo(List.of("created")));
  }

  @Test
  void FR_ENT_02_getListSearchUpdateArchive() {
    Team t = team("ent-crud-it");
    String globex =
        createEntity(
                t.analyst(),
                Map.of(
                    "name", "Globex Clearing S.A.", "entityType", "COUNTERPARTY", "ticker", "GLBX"))
            .data()
            .get("id")
            .asString();
    createEntity(t.analyst(), Map.of("name", "Initech Securities", "entityType", "ORGANIZATION"));
    createEntity(
        t.analyst(),
        Map.of("name", "Umbrella Pharma AG", "entityType", "ORGANIZATION", "ticker", "UMBR"));

    Reply detail = post("getEntity", t.viewer(), Map.of("entityId", globex));
    assertThat(detail.data().get("normalizedName").asString()).isEqualTo("globex clearing");
    assertThat(detail.data().get("watchlists").isArray()).isTrue();

    Reply byType = post("listEntities", t.viewer(), Map.of("entityType", "ORGANIZATION"));
    assertThat(byType.data()).hasSize(2);
    Reply page1 = post("listEntities", t.viewer(), Map.of("limit", 2));
    assertThat(page1.data()).hasSize(2);
    String cursor = page1.body().get("meta").get("nextCursor").asString();
    assertThat(post("listEntities", t.viewer(), Map.of("limit", 2, "cursor", cursor)).data())
        .hasSize(1);
    Reply search = post("listEntities", t.viewer(), Map.of("q", "globex clearng"));
    assertThat(search.data()).isNotEmpty();
    assertThat(search.data().get(0).get("id").asString()).isEqualTo(globex);

    Map<String, Object> clear = new HashMap<>();
    clear.put("entityId", globex);
    clear.put("ticker", null); // explicit null clears
    clear.put("addAliases", List.of("Globex"));
    Reply updated = post("updateEntity", t.analyst(), clear);
    assertThat(updated.status()).isEqualTo(200);
    assertThat(updated.data().get("ticker").isNull()).isTrue();
    assertThat(updated.data().get("aliases").toString()).isEqualTo("[\"Globex\"]");
    Reply untouched =
        post("updateEntity", t.analyst(), Map.of("entityId", globex, "country", "CH"));
    assertThat(untouched.data().get("aliases").toString())
        .isEqualTo("[\"Globex\"]"); // absent fields unchanged

    assertThat(post("archiveEntity", t.analyst(), Map.of("entityId", globex)).status())
        .isEqualTo(403); // TA only
    Reply archived = post("archiveEntity", t.ta(), Map.of("entityId", globex));
    assertThat(archived.data().get("archivedAt").isNull()).isFalse();
    assertThat(post("listEntities", t.viewer(), Map.of()).data()).hasSize(2); // archived excluded
    assertThat(post("getEntity", t.viewer(), Map.of("entityId", globex)).status())
        .isEqualTo(200); // still readable
    // the normalized name is free again for a new, non-archived entity
    assertThat(
            createEntity(t.ta(), Map.of("name", "Globex Clearing", "entityType", "COUNTERPARTY"))
                .status())
        .isEqualTo(201);
  }

  @Test
  void FR_AUTH_06_entitiesAreTenantScoped() {
    Team a = team("ent-iso-a-it");
    Team b = team("ent-iso-b-it");
    String id =
        createEntity(a.analyst(), Map.of("name", "Stark Analytics", "entityType", "ORGANIZATION"))
            .data()
            .get("id")
            .asString();
    assertThat(post("getEntity", b.ta(), Map.of("entityId", id)).status()).isEqualTo(404);
    assertThat(post("updateEntity", b.ta(), Map.of("entityId", id, "country", "US")).status())
        .isEqualTo(404);
    assertThat(post("listEntities", b.viewer(), Map.of()).data()).isEmpty();
    assertThat(
            post(
                    "getEntity",
                    paToken(),
                    Map.of("entityId", id),
                    "X-Aegis-Tenant",
                    a.tenantId().toString())
                .status())
        .isEqualTo(200);
    assertThat(post("getEntity", paToken(), Map.of("entityId", UUID.randomUUID())).status())
        .isEqualTo(403);
  }
}
