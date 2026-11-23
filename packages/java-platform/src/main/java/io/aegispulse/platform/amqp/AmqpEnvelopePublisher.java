package io.aegispulse.platform.amqp;

import io.aegispulse.contracts.envelope.CanonicalEnvelope;
import io.aegispulse.platform.errors.ConsumerFailure.TransientException;
import io.aegispulse.platform.outbox.EnvelopePublisher;
import io.aegispulse.platform.outbox.OutboxMessage;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageDeliveryMode;
import org.springframework.amqp.core.MessageProperties;
import org.springframework.amqp.core.ReturnedMessage;
import org.springframework.amqp.rabbit.connection.CorrelationData;
import org.springframework.amqp.rabbit.core.RabbitTemplate;

/**
 * Confirmed, mandatory publishing (§6.4, §6.5): {@code messageId = eventId}, correlationId, {@code
 * type = eventType}, JSON, persistent, timestamp, {@code x-aegis-tenant} / {@code
 * x-aegis-schema-version}. Returns only after the broker acks; nack, return (unroutable) or timeout
 * throw {@link TransientException}. W3C trace headers are injected by the OpenTelemetry Java
 * agent's Spring Rabbit instrumentation.
 */
public final class AmqpEnvelopePublisher implements EnvelopePublisher {
  private final RabbitTemplate rabbit;
  private final EnvelopeCodec codec;
  private final Duration confirmTimeout;

  public AmqpEnvelopePublisher(
      RabbitTemplate rabbit, EnvelopeCodec codec, Duration confirmTimeout) {
    this.rabbit = rabbit;
    this.codec = codec;
    this.confirmTimeout = confirmTimeout;
  }

  @Override
  public void publish(OutboxMessage message) {
    CanonicalEnvelope e = message.envelope();
    MessageProperties props = new MessageProperties();
    props.setMessageId(e.eventId());
    props.setCorrelationId(e.correlationId());
    props.setType(e.eventType());
    props.setContentType(MessageProperties.CONTENT_TYPE_JSON);
    props.setDeliveryMode(MessageDeliveryMode.PERSISTENT);
    props.setTimestamp(Date.from(Instant.now()));
    props.setHeader(Headers.SCHEMA_VERSION, e.schemaVersion());
    if (e.tenantId() != null) {
      props.setHeader(Headers.TENANT, e.tenantId());
    }
    send(message.exchange(), message.routingKey(), new Message(codec.encode(e), props));
  }

  /**
   * Confirmed copy of a delivery (same body and properties) with merged headers: the retry/DLQ
   * republish (§6.5).
   */
  public void republish(
      Message original, String exchange, String routingKey, Map<String, Object> headers) {
    MessageProperties props = original.getMessageProperties();
    MessageProperties copy = new MessageProperties();
    copy.setMessageId(props.getMessageId());
    copy.setCorrelationId(props.getCorrelationId());
    copy.setType(props.getType());
    copy.setContentType(props.getContentType());
    copy.setDeliveryMode(MessageDeliveryMode.PERSISTENT);
    copy.setTimestamp(props.getTimestamp());
    props.getHeaders().forEach(copy::setHeader);
    copy.getHeaders()
        .remove("x-death"); // broker-managed; the copy starts a fresh dead-letter history
    headers.forEach(copy::setHeader);
    send(exchange, routingKey, new Message(original.getBody(), copy));
  }

  private void send(String exchange, String routingKey, Message message) {
    CorrelationData correlation = new CorrelationData(UUID.randomUUID().toString());
    rabbit.send(exchange, routingKey, message, correlation);
    CorrelationData.Confirm confirm;
    try {
      confirm = correlation.getFuture().get(confirmTimeout.toMillis(), TimeUnit.MILLISECONDS);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new TransientException(
          "DEPENDENCY_UNAVAILABLE", "interrupted waiting for publisher confirm", e);
    } catch (ExecutionException | TimeoutException e) {
      throw new TransientException(
          "DEPENDENCY_UNAVAILABLE", "no publisher confirm for " + exchange, e);
    }
    ReturnedMessage returned = correlation.getReturned();
    if (returned != null) {
      throw new TransientException(
          "DEPENDENCY_UNAVAILABLE",
          "unroutable: " + exchange + "/" + routingKey + " (" + returned.getReplyText() + ")");
    }
    if (!confirm.ack()) {
      throw new TransientException(
          "DEPENDENCY_UNAVAILABLE",
          "broker nacked publish to " + exchange + ": " + confirm.reason());
    }
  }
}
