package io.aegispulse.cases.domain;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** FR-AUD-01 canonical JSON (RFC 8785 for the log's value space) and the chained hash. */
class AuditHashTest {
  @Test
  void canonicalJsonSortsKeysEscapesMinimallyAndNormalizesNumbers_FR_AUD_01() {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("b", List.of(1, new BigDecimal("1.50"), 2.0, "é\n\"x\""));
    m.put("a", Arrays.asList(true, null, Map.of("z", 1, "y", 0)));
    assertThat(AuditHash.canonical(m))
        .isEqualTo("{\"a\":[true,null,{\"y\":0,\"z\":1}],\"b\":[1,1.5,2,\"é\\n\\\"x\\\"\"]}");
    assertThat(AuditHash.canonical("\u0001")).isEqualTo("\"\\u0001\"");
  }

  @Test
  void hashChainsOnThePreviousHashAndDetectsAnyChange_FR_AUD_01() {
    Map<String, Object> e = Map.of("seq", 1, "action", "CASE_OPENED");
    String h1 = AuditHash.hash(Map.copyOf(e), AuditHash.GENESIS);
    assertThat(h1)
        .hasSize(64)
        .isEqualTo(AuditHash.hash(Map.of("action", "CASE_OPENED", "seq", 1), AuditHash.GENESIS));
    assertThat(AuditHash.hash(Map.copyOf(e), "1".repeat(64))).isNotEqualTo(h1);
    assertThat(AuditHash.hash(Map.of("seq", 1, "action", "CASE_OPENEd"), AuditHash.GENESIS))
        .isNotEqualTo(h1);
  }
}
