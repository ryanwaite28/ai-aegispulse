package io.aegispulse.platform.errors;

import java.io.Serial;
import java.sql.SQLTransientException;
import org.springframework.dao.TransientDataAccessException;

/**
 * Consumer failure classes (PROJECT.md §6.5, steering/quality.md "Error classification") and the
 * classifier the AMQP kit uses to choose retry tiers, DLQ, or poison handling.
 */
public final class ConsumerFailure {
  private ConsumerFailure() {}

  /** TRANSIENT → retry tiers then DLQ; PERMANENT and POISON → DLQ immediately. */
  public enum Kind {
    TRANSIENT,
    PERMANENT,
    POISON
  }

  /** Classification result. */
  public record Classified(Kind kind, String code) {}

  /** Retryable: timeout, 5xx, circuit open, connection reset, write conflict. */
  public static final class TransientException extends RuntimeException {
    @Serial private static final long serialVersionUID = 1L;
    private final String code;

    public TransientException(String code, String message, Throwable cause) {
      super(message, cause);
      this.code = code;
    }

    public TransientException(String code, String message) {
      super(message);
      this.code = code;
    }

    public String code() {
      return code;
    }
  }

  /** Never succeeds on retry: dependency 4xx (not 408/429), business rule violation. */
  public static final class PermanentException extends RuntimeException {
    @Serial private static final long serialVersionUID = 1L;
    private final String code;

    public PermanentException(String code, String message) {
      super(message);
      this.code = code;
    }

    public String code() {
      return code;
    }
  }

  /** Undeserializable or schema-invalid message, unknown major schemaVersion. */
  public static final class PoisonMessageException extends RuntimeException {
    @Serial private static final long serialVersionUID = 1L;
    private final String code;

    public PoisonMessageException(String code, String message) {
      super(message);
      this.code = code;
    }

    public String code() {
      return code;
    }
  }

  /**
   * Classifies a failure. Unknown errors are TRANSIENT: a bug gets the bounded retry budget
   * (NFR-10) and then the DLQ.
   */
  public static Classified classify(Throwable error) {
    return switch (error) {
      case PoisonMessageException p -> new Classified(Kind.POISON, p.code());
      case PermanentException p -> new Classified(Kind.PERMANENT, p.code());
      case DomainException d -> new Classified(Kind.PERMANENT, d.code());
      case TransientException t -> new Classified(Kind.TRANSIENT, t.code());
      case TransientDataAccessException t ->
          new Classified(Kind.TRANSIENT, "DEPENDENCY_UNAVAILABLE");
      case SQLTransientException t -> new Classified(Kind.TRANSIENT, "DEPENDENCY_UNAVAILABLE");
      default -> new Classified(Kind.TRANSIENT, "INTERNAL_ERROR");
    };
  }

  /** Log-safe one-line description (class, code, message; no stack), bounded. */
  public static String describe(Throwable error) {
    String code =
        switch (error) {
          case DomainException d -> "[" + d.code() + "]";
          case TransientException t -> "[" + t.code() + "]";
          case PermanentException p -> "[" + p.code() + "]";
          case PoisonMessageException p -> "[" + p.code() + "]";
          default -> "";
        };
    String message = error.getMessage();
    String text = error.getClass().getSimpleName() + code + ": " + (message == null ? "" : message);
    return text.length() > 500 ? text.substring(0, 499) + "…" : text;
  }
}
