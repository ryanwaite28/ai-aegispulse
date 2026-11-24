package io.aegispulse.registry.it;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/** FR-ENT-03 golden mention → entity fixtures, determinism and latency (SERVICE caller). */
class ResolutionIT extends RegistryIt {
  static final String SVC = Tokens.service("svc-orchestrator", "registry.resolveEntities");

  /** Golden table: mention → expected entity name (or null) and match type. */
  static final String[][] GOLDEN = {
    {"ACMH", "ACME Holdings, Inc.", "TICKER_EXACT"},
    {"Acme Capital", "ACME Holdings, Inc.", "ALIAS_EXACT"},
    {"ACME CAPITAL!", "ACME Holdings, Inc.", "ALIAS_EXACT"},
    {"Acme Holdings LLC", "ACME Holdings, Inc.", "NAME_NORMALIZED"},
    {"Globex Clearing", "Globex Clearing S.A.", "NAME_NORMALIZED"},
    // Trigram cases measured with pg_trgm: ≥ 0.85 matches, just-below-threshold does not.
    {"Initech Securitiess", "Initech Securities", "TRIGRAM"}, // 0.857
    {"Initech Securities X", "Initech Securities", "TRIGRAM"}, // 0.905
    {"Globex Clearings", null, null}, // 0.833 < 0.85
    {"Initech Securites", null, null}, // 0.800 < 0.85
    {"Umbrella Pharmaceuticals", null, null},
    {"Umbrella Pharma", "Umbrella Pharma AG", "NAME_NORMALIZED"},
    {"Wayne Enterprises", null, null},
    {"Archived Corp", null, null},
  };

  @Test
  void FR_ENT_03_goldenFixturesDeterministicAndFast() {
    Team t = team("resolve-it");
    Map<String, String> ids = new java.util.HashMap<>();
    for (Object[] e :
        new Object[][] {
          {"ACME Holdings, Inc.", "ORGANIZATION", "ACMH", List.of("Acme Capital")},
          {"Globex Clearing S.A.", "COUNTERPARTY", "GLBX", List.of()},
          {"Initech Securities", "ORGANIZATION", null, List.of()},
          {"Umbrella Pharma AG", "ORGANIZATION", "UMBR", List.of()},
          {"Archived Corp", "ORGANIZATION", "ARCH", List.of()},
        }) {
      Map<String, Object> body =
          new java.util.HashMap<>(Map.of("name", e[0], "entityType", e[1], "aliases", e[3]));
      if (e[2] != null) {
        body.put("ticker", e[2]);
      }
      ids.put((String) e[0], post("createEntity", t.analyst(), body).data().get("id").asString());
    }
    post("archiveEntity", t.ta(), Map.of("entityId", ids.get("Archived Corp")));

    List<String> mentions = Arrays.stream(GOLDEN).map(g -> g[0]).toList();
    Map<String, Object> body =
        Map.of("tenantId", t.tenantId(), "mentions", mentions, "tickers", List.of("UMBR", "ARCH"));
    Reply r = post("resolveEntities", SVC, body);
    assertThat(r.status()).isEqualTo(200);
    JsonNode matches = r.data().get("matches");
    assertThat(matches).hasSize(GOLDEN.length + 2);
    for (int i = 0; i < GOLDEN.length; i++) {
      JsonNode m = matches.get(i);
      String[] g = GOLDEN[i];
      assertThat(m.get("mention").asString()).isEqualTo(g[0]);
      if (g[1] == null) {
        assertThat(m.get("entityId").isNull()).as(g[0]).isTrue();
        assertThat(m.get("matchType").isNull()).as(g[0]).isTrue();
      } else {
        assertThat(m.get("entityId").asString()).as(g[0]).isEqualTo(ids.get(g[1]));
        assertThat(m.get("matchType").asString()).as(g[0]).isEqualTo(g[2]);
        if (g[2].equals("TRIGRAM")) {
          assertThat(m.get("similarity").asDouble())
              .as(g[0])
              .isGreaterThanOrEqualTo(0.85)
              .isLessThan(1.0);
        }
      }
    }
    assertThat(matches.get(GOLDEN.length).get("entityId").asString())
        .isEqualTo(ids.get("Umbrella Pharma AG"));
    assertThat(matches.get(GOLDEN.length + 1).get("entityId").isNull()).isTrue(); // archived ticker
    assertThat(post("resolveEntities", SVC, body).data()).isEqualTo(r.data()); // deterministic

    // A user token is not a resolution caller; a service without the act[] entry is refused.
    assertThat(post("resolveEntities", t.ta(), body).status()).isEqualTo(403);
    assertThat(
            post("resolveEntities", Tokens.service("svc-files", "registry.getTenantSettings"), body)
                .status())
        .isEqualTo(403);

    // FR-ENT-03 latency: 50 mentions, p95 over 40 calls ≤ 50 ms (warm).
    List<String> fifty = new ArrayList<>();
    for (int i = 0; i < 50; i++) {
      fifty.add(mentions.get(i % mentions.size()) + (i >= mentions.size() ? " " + i : ""));
    }
    Map<String, Object> load = Map.of("tenantId", t.tenantId(), "mentions", fifty);
    for (int i = 0; i < 5; i++) {
      post("resolveEntities", SVC, load);
    }
    List<Long> millis = new ArrayList<>();
    for (int i = 0; i < 40; i++) {
      long start = System.nanoTime();
      assertThat(post("resolveEntities", SVC, load).status()).isEqualTo(200);
      millis.add((System.nanoTime() - start) / 1_000_000);
    }
    millis.sort(null);
    long p95 = millis.get((int) Math.ceil(0.95 * millis.size()) - 1);
    System.out.println(
        "FR-ENT-03 resolveEntities 50 mentions: p50=" + millis.get(19) + "ms p95=" + p95 + "ms");
    assertThat(p95).isLessThanOrEqualTo(50);
  }
}
