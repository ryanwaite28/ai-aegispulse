package io.aegispulse.platform.outbox;

import io.aegispulse.contracts.envelope.CanonicalEnvelope;

/**
 * One event to publish: exchange, routing key (= eventType, §6.7) and the full canonical envelope.
 */
public record OutboxMessage(String exchange, String routingKey, CanonicalEnvelope envelope) {
  public OutboxMessage {
    if (!routingKey.equals(envelope.eventType())) {
      throw new IllegalArgumentException("routing key must equal eventType");
    }
  }
}
