package io.aegispulse.platform.logging;

import org.jspecify.annotations.Nullable;
import org.slf4j.MDC;

/**
 * Per-request / per-message log context (NFR-07): correlationId, tenantId, eventId in the MDC for
 * the duration of a try-with-resources block. Previous values are restored on close.
 */
public final class LogContext implements AutoCloseable {
  public static final String CORRELATION_ID = "correlationId";
  public static final String TENANT_ID = "tenantId";
  public static final String EVENT_ID = "eventId";
  public static final String REQUEST_ID = "requestId";

  private final @Nullable String previousCorrelation;
  private final @Nullable String previousTenant;
  private final @Nullable String previousEvent;

  private LogContext(
      @Nullable String correlationId, @Nullable String tenantId, @Nullable String eventId) {
    previousCorrelation = MDC.get(CORRELATION_ID);
    previousTenant = MDC.get(TENANT_ID);
    previousEvent = MDC.get(EVENT_ID);
    put(CORRELATION_ID, correlationId);
    put(TENANT_ID, tenantId);
    put(EVENT_ID, eventId);
  }

  public static LogContext open(
      @Nullable String correlationId, @Nullable String tenantId, @Nullable String eventId) {
    return new LogContext(correlationId, tenantId, eventId);
  }

  private static void put(String key, @Nullable String value) {
    if (value == null) {
      MDC.remove(key);
    } else {
      MDC.put(key, value);
    }
  }

  @Override
  public void close() {
    put(CORRELATION_ID, previousCorrelation);
    put(TENANT_ID, previousTenant);
    put(EVENT_ID, previousEvent);
  }
}
