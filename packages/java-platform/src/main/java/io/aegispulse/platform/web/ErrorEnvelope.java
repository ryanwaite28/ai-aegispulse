package io.aegispulse.platform.web;

import io.aegispulse.platform.errors.DomainException.ErrorDetail;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * §8.2 error response: {@code
 * {"error":{code,message,details},"meta":{requestId,correlationId,traceId}}}.
 */
public record ErrorEnvelope(ErrorBody error, Meta meta) {

  /** The {@code error} member. */
  public record ErrorBody(String code, String message, List<ErrorDetail> details) {}

  /** Meta member; ids are null when unknown. */
  public record Meta(
      @Nullable String requestId, @Nullable String correlationId, @Nullable String traceId) {}

  public static ErrorEnvelope of(
      String code, String message, List<ErrorDetail> details, Meta meta) {
    return new ErrorEnvelope(new ErrorBody(code, message, details), meta);
  }
}
