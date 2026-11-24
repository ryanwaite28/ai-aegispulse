package io.aegispulse.platform.errors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.aegispulse.platform.errors.ConsumerFailure.Kind;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.dao.QueryTimeoutException;

class ConsumerFailureTest {

  @Test
  void classifiesPerQualitySteering_FR_MSG_01() {
    assertThat(
            ConsumerFailure.classify(
                new ConsumerFailure.TransientException("DEPENDENCY_UNAVAILABLE", "x")))
        .isEqualTo(new ConsumerFailure.Classified(Kind.TRANSIENT, "DEPENDENCY_UNAVAILABLE"));
    assertThat(
            ConsumerFailure.classify(new ConsumerFailure.PermanentException("NOT_FOUND", "x"))
                .kind())
        .isEqualTo(Kind.PERMANENT);
    assertThat(
            ConsumerFailure.classify(
                    new ConsumerFailure.PoisonMessageException("ENVELOPE_INVALID", "x"))
                .kind())
        .isEqualTo(Kind.POISON);
    assertThat(ConsumerFailure.classify(new DomainException.Conflict("CONFLICT", "x")))
        .isEqualTo(new ConsumerFailure.Classified(Kind.PERMANENT, "CONFLICT"));
    assertThat(ConsumerFailure.classify(new QueryTimeoutException("slow")).kind())
        .isEqualTo(Kind.TRANSIENT);
    assertThat(ConsumerFailure.classify(new IllegalStateException("bug")))
        .isEqualTo(new ConsumerFailure.Classified(Kind.TRANSIENT, "INTERNAL_ERROR"));
  }

  @Test
  void stackHashGroupsBySiteNotMessage_FR_MSG_02() {
    String a = ConsumerFailure.stackHash(fail("row 1 missing"));
    assertThat(a).matches("[0-9a-f]{16}");
    assertThat(ConsumerFailure.stackHash(fail("row 2 missing"))).isEqualTo(a);
    assertThat(ConsumerFailure.stackHash(new IllegalStateException("row 1 missing")))
        .isNotEqualTo(a);
  }

  @Test
  void deadLetterMessageWithholdsForeignMessages_FR_MSG_02() {
    assertThat(ConsumerFailure.deadLetterMessage(fail("gone")))
        .isEqualTo("PermanentException[NOT_FOUND]: gone");
    assertThat(ConsumerFailure.deadLetterMessage(new IllegalArgumentException("ssn 123-45-6789")))
        .isEqualTo("IllegalArgumentException (message withheld)");
  }

  private static ConsumerFailure.PermanentException fail(String message) {
    return new ConsumerFailure.PermanentException("NOT_FOUND", message);
  }

  @Test
  void describesWithoutStackAndBoundsLength() {
    assertThat(
            ConsumerFailure.describe(
                new ConsumerFailure.TransientException("DEPENDENCY_UNAVAILABLE", "down")))
        .isEqualTo("TransientException[DEPENDENCY_UNAVAILABLE]: down");
    assertThat(ConsumerFailure.describe(new RuntimeException("x".repeat(2000)))).hasSize(500);
  }

  @Test
  void domainExceptionsCarryStableCodesAndStatuses() {
    assertThatThrownBy(() -> new DomainException.NotFound("not-a-code", "x"))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(new DomainException.Validation("VALIDATION_ERROR", "x", List.of()).httpStatus())
        .isEqualTo(422);
    assertThat(new DomainException.Unauthorized("UNAUTHORIZED", "x").httpStatus()).isEqualTo(401);
    assertThat(new DomainException.Forbidden("TENANT_SUSPENDED", "x").httpStatus()).isEqualTo(403);
    assertThat(new DomainException.NotFound("NOT_FOUND", "x").httpStatus()).isEqualTo(404);
    assertThat(new DomainException.Conflict("IDEMPOTENCY_KEY_REUSED", "x").httpStatus())
        .isEqualTo(409);
    assertThat(new DomainException.PayloadTooLarge("PAYLOAD_TOO_LARGE", "x").httpStatus())
        .isEqualTo(413);
    assertThat(new DomainException.RateLimited("AUTH_RATE_LIMITED", "x").httpStatus())
        .isEqualTo(429);
  }
}
