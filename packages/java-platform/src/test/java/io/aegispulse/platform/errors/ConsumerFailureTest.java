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
