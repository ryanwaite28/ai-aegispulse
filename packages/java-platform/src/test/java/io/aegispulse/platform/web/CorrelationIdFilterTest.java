package io.aegispulse.platform.web;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class CorrelationIdFilterTest {
  @Test
  void keepsWellFormedIdsAndReplacesOthers() {
    String good = "corr-0b6e1e6c-6a7d-4c35-9d3b-7f1d4f3b2a10";
    assertThat(CorrelationIdFilter.correlationId(good)).isEqualTo(good);
    assertThat(CorrelationIdFilter.correlationId("corr-<script>"))
        .startsWith("corr-")
        .isNotEqualTo("corr-<script>");
    assertThat(CorrelationIdFilter.correlationId(null)).matches("^corr-[0-9a-f-]{36}$");
    assertThat(CorrelationIdFilter.requestId("req_01J")).isEqualTo("req_01J");
    assertThat(CorrelationIdFilter.requestId("x".repeat(200))).startsWith("req_");
  }
}
