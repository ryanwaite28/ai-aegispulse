package io.aegispulse.platform.amqp;

import static org.assertj.core.api.Assertions.assertThat;

import io.aegispulse.contracts.topology.QueueName;
import io.aegispulse.contracts.topology.Topology;
import io.aegispulse.contracts.topology.Topology.QueuePolicy;
import io.aegispulse.platform.errors.ConsumerFailure;
import io.aegispulse.platform.errors.ConsumerFailure.Kind;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageProperties;

class FailureRouteTest {
  private static final ConsumerFailure.Classified TRANSIENT =
      new ConsumerFailure.Classified(Kind.TRANSIENT, "X");

  @Test
  void retriesTransientThroughTheContractTiersThenDeadLetters_FR_MSG_01() {
    QueuePolicy audit = Topology.policy(QueueName.CASES_AUDIT_INGEST_Q);
    assertThat(audit.prefetch()).isEqualTo(20);
    assertThat(FailureRoute.decide(audit, 0, TRANSIENT).routingKey())
        .isEqualTo("cases.audit-ingest.q.retry.1s");
    assertThat(FailureRoute.decide(audit, 1, TRANSIENT).routingKey())
        .isEqualTo("cases.audit-ingest.q.retry.5s");
    assertThat(FailureRoute.decide(audit, 2, TRANSIENT).routingKey())
        .isEqualTo("cases.audit-ingest.q.retry.30s");
    assertThat(FailureRoute.decide(audit, 3, TRANSIENT))
        .isEqualTo(new FailureRoute(FailureRoute.Action.DEAD_LETTER, "cases.audit-ingest.q"));
    assertThat(
            FailureRoute.decide(Topology.policy(QueueName.DOC_EXTRACTION_Q), 0, TRANSIENT)
                .routingKey())
        .isEqualTo("doc.extraction.q.retry.5s");
  }

  @Test
  void deadLettersPermanentAndPoisonImmediately() {
    QueuePolicy audit = Topology.policy(QueueName.CASES_AUDIT_INGEST_Q);
    assertThat(
            FailureRoute.decide(
                    audit, 0, new ConsumerFailure.Classified(Kind.PERMANENT, "NOT_FOUND"))
                .action())
        .isEqualTo(FailureRoute.Action.DEAD_LETTER);
    assertThat(
            FailureRoute.decide(
                    audit, 0, new ConsumerFailure.Classified(Kind.POISON, "ENVELOPE_INVALID"))
                .action())
        .isEqualTo(FailureRoute.Action.DEAD_LETTER);
  }

  @Test
  void queuesWithoutRetryTiersOrDlq() {
    // enrichment-timer has a DLQ but no retry tiers; events.deadletter.q has neither (no DLX
    // self-loop)
    assertThat(
            FailureRoute.decide(Topology.policy(QueueName.CASES_ENRICHMENT_TIMER_Q), 0, TRANSIENT)
                .action())
        .isEqualTo(FailureRoute.Action.DEAD_LETTER);
    assertThat(
            FailureRoute.decide(Topology.policy(QueueName.EVENTS_DEADLETTER_Q), 0, TRANSIENT)
                .action())
        .isEqualTo(FailureRoute.Action.REQUEUE);
  }

  @Test
  void readsRetryHeadersDefensively() {
    MessageProperties p = new MessageProperties();
    p.setHeader(Headers.RETRY_COUNT, 2);
    p.setHeader(Headers.REPLAY_GENERATION, "3");
    p.setHeader("bad", "-1; drop");
    Message m = new Message(new byte[0], p);
    Map<String, Object> h = m.getMessageProperties().getHeaders();
    assertThat(EnvelopeListener.headerInt(h, Headers.RETRY_COUNT)).isEqualTo(2);
    assertThat(EnvelopeListener.headerInt(h, Headers.REPLAY_GENERATION)).isEqualTo(3);
    assertThat(EnvelopeListener.headerInt(h, "bad")).isZero();
    assertThat(EnvelopeListener.headerInt(h, "absent")).isZero();
  }
}
