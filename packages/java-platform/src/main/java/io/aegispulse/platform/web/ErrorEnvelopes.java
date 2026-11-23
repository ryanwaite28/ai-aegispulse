package io.aegispulse.platform.web;

import io.aegispulse.platform.errors.DomainException.ErrorDetail;
import io.aegispulse.platform.logging.LogContext;
import java.util.List;
import org.jspecify.annotations.Nullable;
import org.slf4j.MDC;

/** Builds §8.2 error envelopes from the current log context. */
public final class ErrorEnvelopes {
  private ErrorEnvelopes() {}

  public static ErrorEnvelope current(String code, String message, List<ErrorDetail> details) {
    return ErrorEnvelope.of(code, message, details, meta());
  }

  public static ErrorEnvelope.Meta meta() {
    return new ErrorEnvelope.Meta(
        MDC.get(LogContext.REQUEST_ID), MDC.get(LogContext.CORRELATION_ID), traceId());
  }

  private static @Nullable String traceId() {
    String id = MDC.get("trace_id");
    return id != null ? id : MDC.get("traceId");
  }
}
