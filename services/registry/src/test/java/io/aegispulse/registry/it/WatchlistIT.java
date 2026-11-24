package io.aegispulse.registry.it;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/** FR-ENT-04/05 over the internal API. */
class WatchlistIT extends RegistryIt {
  static final String SVC = Tokens.service("svc-orchestrator", "registry.checkWatchlists");

  @Test
  void FR_ENT_04_05_lifecycleEntriesPauseAndChecks() {
    Team t = team("wl-life-it");
    String globex =
        post(
                "createEntity",
                t.analyst(),
                Map.of("name", "Globex Clearing", "entityType", "COUNTERPARTY", "ticker", "GLBX"))
            .data()
            .get("id")
            .asString();
    String initech =
        post(
                "createEntity",
                t.analyst(),
                Map.of("name", "Initech Securities", "entityType", "ORGANIZATION"))
            .data()
            .get("id")
            .asString();

    Reply wl =
        post(
            "createWatchlist",
            t.analyst(),
            Map.of("name", "Sanctions Watch", "reason", "OFAC review"));
    assertThat(wl.status()).isEqualTo(201);
    assertThat(wl.data().get("severityFloor").asString()).isEqualTo("HIGH");
    assertThat(wl.data().get("status").asString()).isEqualTo("ACTIVE");
    String wlId = wl.data().get("id").asString();
    Reply dup =
        post("createWatchlist", t.analyst(), Map.of("name", "sanctions watch", "reason", "x"));
    assertThat(dup.code()).isEqualTo("WATCHLIST_NAME_TAKEN");

    Reply entry =
        post(
            "addWatchlistEntry",
            t.analyst(),
            Map.of("watchlistId", wlId, "entityId", globex, "note", "sanctioned"));
    assertThat(entry.status()).isEqualTo(201);
    assertThat(post("listWatchlists", t.viewer(), Map.of()).data().get(0).get("entryCount").asInt())
        .isEqualTo(1);
    assertThat(
            post("getEntity", t.viewer(), Map.of("entityId", globex))
                .data()
                .get("watchlists")
                .get(0)
                .get("name")
                .asString())
        .isEqualTo("Sanctions Watch");

    Map<String, Object> check =
        Map.of("tenantId", t.tenantId(), "entityIds", List.of(globex, initech));
    JsonNode hits = post("checkWatchlists", SVC, check).data().get("hits");
    assertThat(hits).hasSize(1);
    assertThat(hits.get(0).get("watchlistName").asString()).isEqualTo("Sanctions Watch");
    assertThat(hits.get(0).get("severityFloor").asString()).isEqualTo("HIGH");
    assertThat(hits.get(0).get("entityId").asString()).isEqualTo(globex);

    // Counterparty refs resolve through FR-ENT-03 (name first, then id as a mention).
    JsonNode cp =
        post(
                "checkWatchlists",
                SVC,
                Map.of(
                    "tenantId",
                    t.tenantId(),
                    "counterpartyRefs",
                    List.of(
                        Map.of("counterpartyId", "CP-77", "counterpartyName", "GLOBEX CLEARING"),
                        Map.of("counterpartyId", "GLBX"),
                        Map.of("counterpartyId", "CP-00"))))
            .data()
            .get("hits");
    assertThat(cp)
        .extracting(h -> h.get("counterpartyId").asString())
        .containsExactly("CP-77", "GLBX");

    // Paused → no hits; resumed → hits again.
    post("updateWatchlist", t.analyst(), Map.of("watchlistId", wlId, "status", "PAUSED"));
    assertThat(post("checkWatchlists", SVC, check).data().get("hits")).isEmpty();
    post("updateWatchlist", t.analyst(), Map.of("watchlistId", wlId, "status", "ACTIVE"));
    assertThat(post("checkWatchlists", SVC, check).data().get("hits")).hasSize(1);

    // Removed entry stops matching; deleting the watchlist is TENANT_ADMIN only.
    assertThat(
            post(
                    "removeWatchlistEntry",
                    t.analyst(),
                    Map.of("watchlistId", wlId, "entityId", globex))
                .status())
        .isEqualTo(200);
    assertThat(post("checkWatchlists", SVC, check).data().get("hits")).isEmpty();
    assertThat(
            post(
                    "removeWatchlistEntry",
                    t.analyst(),
                    Map.of("watchlistId", wlId, "entityId", globex))
                .status())
        .isEqualTo(404);
    assertThat(post("deleteWatchlist", t.analyst(), Map.of("watchlistId", wlId)).status())
        .isEqualTo(403);
    assertThat(post("deleteWatchlist", t.ta(), Map.of("watchlistId", wlId)).status())
        .isEqualTo(200);
    assertThat(post("listWatchlists", t.viewer(), Map.of()).data()).isEmpty();
    // The name is free again after deletion.
    assertThat(
            post(
                    "createWatchlist",
                    t.analyst(),
                    Map.of("name", "Sanctions Watch", "reason", "again"))
                .status())
        .isEqualTo(201);

    assertThat(
            awaitEvents(
                e ->
                    e.eventType().equals("registry.watchlist.changed")
                        && wlId.equals(e.payload().get("watchlistId")),
                6))
        .extracting(e -> e.payload().get("changedFields"))
        .contains(List.of("created"), List.of("entries"), List.of("status"), List.of("deleted"));
  }

  @Test
  void FR_ENT_05_archivedEntitiesStopMatchingAndTenantsAreIsolated() {
    Team a = team("wl-iso-a-it");
    Team b = team("wl-iso-b-it");
    String ent =
        post("createEntity", a.analyst(), Map.of("name", "Hooli", "entityType", "ORGANIZATION"))
            .data()
            .get("id")
            .asString();
    String wl =
        post("createWatchlist", a.analyst(), Map.of("name", "Watch", "reason", "r"))
            .data()
            .get("id")
            .asString();
    post("addWatchlistEntry", a.analyst(), Map.of("watchlistId", wl, "entityId", ent));
    assertThat(
            post(
                    "checkWatchlists",
                    SVC,
                    Map.of("tenantId", a.tenantId(), "entityIds", List.of(ent)))
                .data()
                .get("hits"))
        .hasSize(1);
    // Tenant B sees nothing of A's.
    assertThat(
            post(
                    "checkWatchlists",
                    SVC,
                    Map.of("tenantId", b.tenantId(), "entityIds", List.of(ent)))
                .data()
                .get("hits"))
        .isEmpty();
    assertThat(post("updateWatchlist", b.ta(), Map.of("watchlistId", wl, "name", "x")).status())
        .isEqualTo(404);
    assertThat(
            post("addWatchlistEntry", b.ta(), Map.of("watchlistId", wl, "entityId", ent)).status())
        .isEqualTo(404);
    // Archived entity: no longer matched, and cannot be added.
    post("archiveEntity", a.ta(), Map.of("entityId", ent));
    assertThat(
            post(
                    "checkWatchlists",
                    SVC,
                    Map.of("tenantId", a.tenantId(), "entityIds", List.of(ent)))
                .data()
                .get("hits"))
        .isEmpty();
    assertThat(
            post("addWatchlistEntry", a.analyst(), Map.of("watchlistId", wl, "entityId", ent))
                .status())
        .isEqualTo(404);
    assertThat(post("checkWatchlists", SVC, Map.of("tenantId", a.tenantId())).status())
        .isEqualTo(422);
  }
}
