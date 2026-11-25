package io.aegispulse.cases.adapters.http;

import com.fasterxml.jackson.annotation.JsonInclude;
import io.aegispulse.platform.logging.LogContext;
import org.jspecify.annotations.Nullable;
import org.slf4j.MDC;

/** §8.2 success envelope {@code { data, meta }}. */
record Success<T>(T data, Meta meta) {
  @JsonInclude(JsonInclude.Include.NON_NULL)
  record Meta(
      @Nullable String requestId, @Nullable String correlationId, @Nullable String nextCursor) {}

  static <T> Success<T> of(T data) {
    return new Success<>(
        data, new Meta(MDC.get(LogContext.REQUEST_ID), MDC.get(LogContext.CORRELATION_ID), null));
  }
}
