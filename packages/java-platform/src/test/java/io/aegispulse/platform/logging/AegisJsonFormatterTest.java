package io.aegispulse.platform.logging;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.spi.LoggingEvent;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.slf4j.event.KeyValuePair;
import org.springframework.mock.env.MockEnvironment;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** NFR-07 mandatory fields and redaction. */
class AegisJsonFormatterTest {
  private final AegisJsonFormatter formatter =
      new AegisJsonFormatter(
          new MockEnvironment()
              .withProperty("aegis.service", "cases")
              .withProperty("aegis.version", "abc1234")
              .withProperty("aegis.env", "local"));

  private JsonNode format(LoggingEvent event) {
    String line = formatter.format(event);
    assertThat(line).endsWith("\n").doesNotContain("\n\n");
    return JsonMapper.builder().build().readTree(line);
  }

  private static LoggingEvent event(String message, Map<String, String> mdc) {
    LoggingEvent e = new LoggingEvent();
    e.setLoggerContext(new LoggerContext());
    e.setLoggerName("io.aegispulse.cases.Test");
    e.setLevel(Level.INFO);
    e.setMessage(message);
    e.setTimeStamp(1_763_000_000_000L);
    e.setMDCPropertyMap(mdc);
    return e;
  }

  @Test
  void emitsMandatoryFieldsFromMdcAndOtelKeys() {
    JsonNode line =
        format(
            event(
                "case opened",
                Map.of(
                    "trace_id", "4bf92f3577b34da6a3ce929d0e0e4736",
                    "span_id", "00f067aa0ba902b7",
                    "correlationId", "corr-1",
                    "tenantId", "t-1",
                    "eventId", "e-1")));
    assertThat(line.get("ts").asString()).isEqualTo("2025-11-13T02:13:20Z");
    assertThat(line.get("level").asString()).isEqualTo("info");
    assertThat(line.get("service").asString()).isEqualTo("cases");
    assertThat(line.get("version").asString()).isEqualTo("abc1234");
    assertThat(line.get("env").asString()).isEqualTo("local");
    assertThat(line.get("traceId").asString()).isEqualTo("4bf92f3577b34da6a3ce929d0e0e4736");
    assertThat(line.get("spanId").asString()).isEqualTo("00f067aa0ba902b7");
    assertThat(line.get("correlationId").asString()).isEqualTo("corr-1");
    assertThat(line.get("tenantId").asString()).isEqualTo("t-1");
    assertThat(line.get("eventId").asString()).isEqualTo("e-1");
    assertThat(line.get("msg").asString()).isEqualTo("case opened");
    assertThat(line.has("trace_id")).isFalse();
  }

  @Test
  void redactsSensitiveKeyValuesAndMdc() {
    LoggingEvent e =
        event(
            "login attempt",
            Map.of("authorization", "Bearer abc", "queue", "cases.audit-ingest.q"));
    e.setKeyValuePairs(
        List.of(
            new KeyValuePair("password", "p1"),
            new KeyValuePair("rawBody", "{}"),
            new KeyValuePair("attempt", 2)));
    JsonNode line = format(e);
    assertThat(line.toString()).doesNotContain("Bearer abc").doesNotContain("p1");
    assertThat(line.get("authorization").asString()).isEqualTo(AegisJsonFormatter.REDACTED);
    assertThat(line.get("password").asString()).isEqualTo(AegisJsonFormatter.REDACTED);
    assertThat(line.get("rawBody").asString()).isEqualTo(AegisJsonFormatter.REDACTED);
    assertThat(line.get("attempt").asString()).isEqualTo("2");
    assertThat(line.get("queue").asString()).isEqualTo("cases.audit-ingest.q");
  }
}
