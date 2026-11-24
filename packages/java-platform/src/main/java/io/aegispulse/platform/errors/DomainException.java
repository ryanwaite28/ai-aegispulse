package io.aegispulse.platform.errors;

import java.io.Serial;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Business-level failure with a stable PROJECT.md §8.4 code (§6.8: sealed hierarchy). The kind
 * fixes the HTTP status and the consumer outcome; the code is the wire contract. Never carries
 * secrets or raw input values.
 */
public abstract sealed class DomainException extends RuntimeException
    permits DomainException.Validation,
        DomainException.Unauthorized,
        DomainException.Forbidden,
        DomainException.NotFound,
        DomainException.Conflict,
        DomainException.PayloadTooLarge,
        DomainException.RateLimited {

  @Serial private static final long serialVersionUID = 1L;
  private static final Pattern CODE = Pattern.compile("^[A-Z][A-Z0-9_]*$");

  private final String code;
  private final transient List<ErrorDetail> details;

  /** One field-level problem (§8.2 {@code details[]}). */
  public record ErrorDetail(String field, String issue) {}

  private DomainException(String code, String message, List<ErrorDetail> details) {
    super(message);
    if (!CODE.matcher(code).matches()) {
      throw new IllegalArgumentException("invalid error code");
    }
    this.code = code;
    this.details = List.copyOf(details);
  }

  public final String code() {
    return code;
  }

  public final List<ErrorDetail> details() {
    return details;
  }

  /** HTTP status for this kind (§8.4). */
  public abstract int httpStatus();

  /** 422 (VALIDATION_ERROR, AUTH_PASSWORD_POLICY, FILE_TYPE_NOT_ALLOWED, ...). */
  public static final class Validation extends DomainException {
    @Serial private static final long serialVersionUID = 1L;

    public Validation(String code, String message, List<ErrorDetail> details) {
      super(code, message, details);
    }

    @Override
    public int httpStatus() {
      return 422;
    }
  }

  /** 401 (UNAUTHORIZED, AUTH_INVALID_CREDENTIALS, ...). */
  public static final class Unauthorized extends DomainException {
    @Serial private static final long serialVersionUID = 1L;

    public Unauthorized(String code, String message) {
      super(code, message, List.of());
    }

    @Override
    public int httpStatus() {
      return 401;
    }
  }

  /** 403 (FORBIDDEN, TENANT_SUSPENDED, ...). */
  public static final class Forbidden extends DomainException {
    @Serial private static final long serialVersionUID = 1L;

    public Forbidden(String code, String message) {
      super(code, message, List.of());
    }

    @Override
    public int httpStatus() {
      return 403;
    }
  }

  /** 404: absent or owned by another tenant (never reveal which). */
  public static final class NotFound extends DomainException {
    @Serial private static final long serialVersionUID = 1L;

    public NotFound(String code, String message) {
      super(code, message, List.of());
    }

    @Override
    public int httpStatus() {
      return 404;
    }
  }

  /** 409 (CONFLICT, IDEMPOTENCY_KEY_REUSED, LAST_TENANT_ADMIN, ...). */
  public static final class Conflict extends DomainException {
    @Serial private static final long serialVersionUID = 1L;

    public Conflict(String code, String message) {
      super(code, message, List.of());
    }

    @Override
    public int httpStatus() {
      return 409;
    }
  }

  /** 413 (PAYLOAD_TOO_LARGE, ...). */
  public static final class PayloadTooLarge extends DomainException {
    @Serial private static final long serialVersionUID = 1L;

    public PayloadTooLarge(String code, String message) {
      super(code, message, List.of());
    }

    @Override
    public int httpStatus() {
      return 413;
    }
  }

  /** 429 (RATE_LIMITED, AUTH_RATE_LIMITED, ...). */
  public static final class RateLimited extends DomainException {
    @Serial private static final long serialVersionUID = 1L;

    public RateLimited(String code, String message) {
      super(code, message, List.of());
    }

    @Override
    public int httpStatus() {
      return 429;
    }
  }
}
