package io.aegispulse.platform.amqp;

import com.rabbitmq.client.Channel;
import io.aegispulse.contracts.envelope.CanonicalEnvelope;
import io.aegispulse.contracts.topology.Topology;
import io.aegispulse.contracts.topology.Topology.QueuePolicy;
import io.aegispulse.platform.errors.ConsumerFailure;
import io.aegispulse.platform.logging.LogContext;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.rabbit.listener.api.ChannelAwareMessageListener;

/**
 * Consumer kit (§6.5, FR-MSG-01): validate envelope → log context → one handler → ack. Failures are
 * classified and republished (confirm-then-ack) to the retry tier or the DLX; if the republish
 * fails the original is nack-requeued. Emits {@code
 * aegispulse_consumer_processed_total{queue,outcome}}.
 */
public final class EnvelopeListener implements ChannelAwareMessageListener {
  private static final Logger log = LoggerFactory.getLogger(EnvelopeListener.class);

  private final QueuePolicy policy;
  private final EnvelopeHandler handler;
  private final EnvelopeCodec codec;
  private final AmqpEnvelopePublisher publisher;
  private final @Nullable MeterRegistry meters;

  public EnvelopeListener(
      QueuePolicy policy,
      EnvelopeHandler handler,
      EnvelopeCodec codec,
      AmqpEnvelopePublisher publisher,
      @Nullable MeterRegistry meters) {
    this.policy = policy;
    this.handler = handler;
    this.codec = codec;
    this.publisher = publisher;
    this.meters = meters;
  }

  static int headerInt(Map<String, @Nullable Object> headers, String name) {
    Object raw = headers.get(name);
    long value =
        switch (raw) {
          case Number n -> n.longValue();
          case String s when s.matches("^[0-9]{1,9}$") -> Long.parseLong(s);
          case null, default -> 0;
        };
    return value < 0 || value > Integer.MAX_VALUE ? 0 : (int) value;
  }

  private void count(String outcome) {
    if (meters != null) {
      Counter.builder("aegispulse_consumer_processed_total")
          .tag("queue", policy.queue().wireName())
          .tag("outcome", outcome)
          .register(meters)
          .increment();
    }
  }

  @Override
  public void onMessage(Message message, @Nullable Channel channel) throws Exception {
    if (channel == null) {
      throw new IllegalStateException("manual-ack listener requires a channel");
    }
    long tag = message.getMessageProperties().getDeliveryTag();
    Map<String, @Nullable Object> headers = message.getMessageProperties().getHeaders();
    int retryCount = headerInt(headers, Headers.RETRY_COUNT);
    CanonicalEnvelope envelope;
    try {
      envelope = codec.decode(message.getBody());
    } catch (ConsumerFailure.PoisonMessageException e) {
      count(settleFailure(message, channel, tag, retryCount, e));
      return;
    }
    Object replayJob = headers.get(Headers.REPLAY_JOB);
    EnvelopeHandler.DeliveryContext context =
        new EnvelopeHandler.DeliveryContext(
            policy.queue(),
            retryCount,
            headerInt(headers, Headers.REPLAY_GENERATION),
            replayJob == null ? null : replayJob.toString(),
            Boolean.TRUE.equals(message.getMessageProperties().getRedelivered()));
    try (LogContext ignored =
        LogContext.open(envelope.correlationId(), envelope.tenantId(), envelope.eventId())) {
      String outcome;
      try {
        EnvelopeHandler.Outcome result = handler.handle(envelope, context);
        channel.basicAck(tag, false);
        outcome = result == EnvelopeHandler.Outcome.DUPLICATE ? "duplicate" : "success";
      } catch (Exception e) {
        outcome = settleFailure(message, channel, tag, retryCount, e);
      }
      count(outcome);
    }
  }

  private String settleFailure(
      Message message, Channel channel, long tag, int retryCount, Exception error)
      throws java.io.IOException {
    ConsumerFailure.Classified failure = ConsumerFailure.classify(error);
    FailureRoute route = FailureRoute.decide(policy, retryCount, failure);
    String described = ConsumerFailure.describe(error);
    try {
      return switch (route.action()) {
        case RETRY -> {
          publisher.republish(
              message,
              Topology.RETRY_EXCHANGE.wireName(),
              java.util.Objects.requireNonNull(route.routingKey()),
              Map.of(Headers.RETRY_COUNT, retryCount + 1));
          channel.basicAck(tag, false);
          log.atWarn()
              .addKeyValue("code", failure.code())
              .addKeyValue("retryCount", retryCount)
              .addKeyValue("tier", route.routingKey())
              .addKeyValue("err", described)
              .log("handler failed; scheduled retry");
          yield "retry";
        }
        case DEAD_LETTER -> {
          publisher.republish(
              message,
              Topology.DEAD_LETTER_EXCHANGE.wireName(),
              policy.queue().wireName(),
              Map.of(
                  Headers.ERROR_CODE,
                  failure.code(),
                  Headers.ORIGINAL_QUEUE,
                  policy.queue().wireName(),
                  Headers.ERROR_MESSAGE,
                  ConsumerFailure.deadLetterMessage(error),
                  Headers.ERROR_STACK_HASH,
                  ConsumerFailure.stackHash(error)));
          channel.basicAck(tag, false);
          log.atError()
              .addKeyValue("code", failure.code())
              .addKeyValue("kind", failure.kind())
              .addKeyValue("err", described)
              .log("message dead-lettered");
          yield "dead_letter";
        }
        case REQUEUE -> {
          channel.basicNack(tag, false, true);
          log.atError()
              .addKeyValue("err", described)
              .log("handler failed on a queue without DLQ; requeued");
          yield "requeue";
        }
      };
    } catch (RuntimeException republishError) {
      channel.basicNack(tag, false, true);
      log.atError()
          .addKeyValue("err", described)
          .addKeyValue("republishErr", ConsumerFailure.describe(republishError))
          .log("retry/DLQ republish failed; original requeued");
      return "requeue";
    }
  }
}
