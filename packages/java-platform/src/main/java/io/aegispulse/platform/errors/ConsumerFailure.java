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

  /**
   * The {@code x-aegis-error-message} value (§6.4, FR-MSG-02): the full description only for the
   * platform's own exception types (messages written by our code); any other exception (Jackson,
   * JDBC, driver) may embed input values, so only its type travels.
   */
  public static String deadLetterMessage(Throwable error) {
    return switch (error) {
      case DomainException d -> describe(d);
      case TransientException t -> describe(t);
      case PermanentException p -> describe(p);
      case PoisonMessageException p -> describe(p);
      default -> error.getClass().getSimpleName() + " (message withheld)";
    };
  }

  /** Stack frames hashed by {@link #stackHash}: enough to tell call sites apart, bounded. */
  private static final int STACK_HASH_FRAMES = 10;

  /**
   * Groups identical failures for the dead-letter registry (§6.4 {@code x-aegis-error-stack-hash},
   * FR-MSG-02): first 16 hex of SHA-256 over the error class name and its top stack frames without
   * line numbers. The message is excluded because it may vary per delivery.
   */
  public static String stackHash(Throwable error) {
    StringBuilder material = new StringBuilder(error.getClass().getName());
    StackTraceElement[] frames = error.getStackTrace();
    for (int i = 0; i < Math.min(STACK_HASH_FRAMES, frames.length); i++) {
      material
          .append('\n')
          .append(frames[i].getClassName())
          .append('.')
          .append(frames[i].getMethodName());
    }
    try {
      byte[] digest =
          java.security.MessageDigest.getInstance("SHA-256")
              .digest(material.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
      return java.util.HexFormat.of().formatHex(digest).substring(0, 16);
    } catch (java.security.NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-256 unavailable", e);
    }
  }
}
