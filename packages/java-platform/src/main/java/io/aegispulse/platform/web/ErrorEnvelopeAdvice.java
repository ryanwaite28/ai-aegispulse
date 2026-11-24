package io.aegispulse.platform.web;

import io.aegispulse.platform.errors.ConsumerFailure;
import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.platform.errors.DomainException.ErrorDetail;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * Maps exceptions to the §8.2 error envelope with §8.4 codes. Unhandled failures become 500
 * INTERNAL_ERROR with the traceId; stack traces never reach clients.
 */
@RestControllerAdvice
public class ErrorEnvelopeAdvice {
  private static final Logger log = LoggerFactory.getLogger(ErrorEnvelopeAdvice.class);

  @ExceptionHandler(DomainException.class)
  public ResponseEntity<ErrorEnvelope> domain(DomainException e) {
    return ResponseEntity.status(e.httpStatus())
        .body(
            ErrorEnvelopes.current(
                e.code(),
                java.util.Objects.requireNonNullElse(e.getMessage(), e.code()),
                e.details()));
  }

  @ExceptionHandler(MethodArgumentNotValidException.class)
  public ResponseEntity<ErrorEnvelope> invalid(MethodArgumentNotValidException e) {
    List<ErrorDetail> details =
        e.getBindingResult().getFieldErrors().stream()
            .map(f -> new ErrorDetail(f.getField(), f.getCode() == null ? "invalid" : f.getCode()))
            .toList();
    return ResponseEntity.status(422)
        .body(ErrorEnvelopes.current("VALIDATION_ERROR", "request failed validation", details));
  }

  @ExceptionHandler({
    HttpMessageNotReadableException.class,
    HttpMediaTypeNotSupportedException.class
  })
  public ResponseEntity<ErrorEnvelope> badRequest(Exception e) {
    return ResponseEntity.status(400)
        .body(
            ErrorEnvelopes.current(
                "BAD_REQUEST", "malformed request or unsupported content type", List.of()));
  }

  @ExceptionHandler(AccessDeniedException.class)
  public ResponseEntity<ErrorEnvelope> forbidden(AccessDeniedException e) {
    return ResponseEntity.status(403)
        .body(ErrorEnvelopes.current("FORBIDDEN", "not allowed", List.of()));
  }

  @ExceptionHandler(Exception.class)
  public ResponseEntity<ErrorEnvelope> unhandled(Exception e) {
    log.atError().addKeyValue("err", ConsumerFailure.describe(e)).log("unhandled request failure");
    return ResponseEntity.status(500)
        .body(ErrorEnvelopes.current("INTERNAL_ERROR", "internal error", List.of()));
  }
}
