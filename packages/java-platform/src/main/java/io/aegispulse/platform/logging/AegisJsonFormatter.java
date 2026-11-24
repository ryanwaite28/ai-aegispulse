package io.aegispulse.platform.logging;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.jspecify.annotations.Nullable;
import org.slf4j.event.KeyValuePair;
import org.springframework.boot.json.JsonWriter;
import org.springframework.boot.logging.structured.StructuredLogFormatter;
import org.springframework.core.env.Environment;

/**
 * Structured JSON log line with the NFR-07 mandatory fields: ts, level, service, version, env,
 * traceId, spanId, correlationId, tenantId, eventId, msg. Key/value pairs and MDC entries are
 * included; sensitive keys are censored by name, and stack traces are reduced to class + message
 * (no raw bodies, secrets or PII).
 */
public final class AegisJsonFormatter implements StructuredLogFormatter<ILoggingEvent> {

  public static final String REDACTED = "[REDACTED]";

  /** Lower-cased key names that are always censored. */
  static final Set<String> SENSITIVE_KEYS =
      Set.of(
          "password",
          "newpassword",
          "currentpassword",
          "secret",
          "clientsecret",
          "client_secret",
          "token",
          "accesstoken",
          "refreshtoken",
          "authorization",
          "cookie",
          "apikey",
          "privatekey",
          "rawbody",
          "rawbodybase64",
          "body",
          "content",
          "filecontent",
          "signature",
          "kek");

  /**
   * MDC keys mapped to NFR-07 field names (OTel agent writes trace_id/span_id; Micrometer writes
   * traceId/spanId).
   */
  private static final List<String[]> MDC_FIELDS =
      List.of(
          new String[] {"traceId", "traceId", "trace_id"},
          new String[] {"spanId", "spanId", "span_id"},
          new String[] {"correlationId", LogContext.CORRELATION_ID},
          new String[] {"tenantId", LogContext.TENANT_ID},
          new String[] {"eventId", LogContext.EVENT_ID},
          new String[] {"requestId", LogContext.REQUEST_ID});

  private static final Set<String> RESERVED_MDC =
      Set.of(
          "traceId",
          "spanId",
          "trace_id",
          "span_id",
          "trace_flags",
          "correlationId",
          "tenantId",
          "eventId",
          "requestId");

  private final String service;
  private final String version;
  private final String env;
  private final JsonWriter<Map<String, @Nullable Object>> writer = JsonWriter.standard();

  public AegisJsonFormatter(Environment environment) {
    this.service =
        environment.getProperty(
            "aegis.service", environment.getProperty("spring.application.name", "unknown"));
    this.version = environment.getProperty("aegis.version", "unknown");
    this.env = environment.getProperty("aegis.env", "unknown");
  }

  static boolean isSensitive(String key) {
    return SENSITIVE_KEYS.contains(key.toLowerCase(Locale.ROOT));
  }

  @Override
  public String format(ILoggingEvent event) {
    Map<String, @Nullable Object> line = new LinkedHashMap<>();
    line.put("ts", Instant.ofEpochMilli(event.getTimeStamp()).toString());
    line.put("level", event.getLevel().toString().toLowerCase(Locale.ROOT));
    line.put("service", service);
    line.put("version", version);
    line.put("env", env);
    Map<String, String> mdc = event.getMDCPropertyMap();
    for (String[] field : MDC_FIELDS) {
      for (int i = 1; i < field.length; i++) {
        String value = mdc.get(field[i]);
        if (value != null) {
          line.put(field[0], value);
          break;
        }
      }
    }
    line.put("logger", event.getLoggerName());
    line.put("msg", event.getFormattedMessage());
    for (Map.Entry<String, String> e : mdc.entrySet()) {
      if (!RESERVED_MDC.contains(e.getKey()) && !line.containsKey(e.getKey())) {
        line.put(e.getKey(), isSensitive(e.getKey()) ? REDACTED : e.getValue());
      }
    }
    List<KeyValuePair> pairs = event.getKeyValuePairs();
    if (pairs != null) {
      for (KeyValuePair kv : pairs) {
        if (!line.containsKey(kv.key)) {
          line.put(kv.key, isSensitive(kv.key) ? REDACTED : String.valueOf(kv.value));
        }
      }
    }
    IThrowableProxy error = event.getThrowableProxy();
    if (error != null) {
      line.put("err", error.getClassName() + ": " + error.getMessage());
    }
    return writer.writeToString(line) + "\n";
  }
}
