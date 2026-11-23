package io.aegispulse.platform.outbox;

import static org.assertj.core.api.Assertions.assertThat;

import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import org.junit.jupiter.api.Test;

/** NFR-07: idle relay polling must not produce sampled traces. */
class OutboxRelayTest {
  @Test
  void pollsRunUnderAValidUnsampledParent() {
    SpanContext parent = Span.fromContext(OutboxRelay.quietContext()).getSpanContext();
    assertThat(parent.isValid()).isTrue();
    assertThat(parent.isSampled()).isFalse();
    assertThat(OutboxRepository.backoffSeconds(1)).isEqualTo(2);
    assertThat(OutboxRepository.backoffSeconds(20)).isEqualTo(OutboxRepository.MAX_BACKOFF_SECONDS);
  }
}
