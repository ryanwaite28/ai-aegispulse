package io.aegispulse.platform.outbox;

/**
 * Confirmed publish of a canonical envelope; throws when the broker did not confirm (nack, return,
 * timeout).
 */
public interface EnvelopePublisher {
  void publish(OutboxMessage message);
}
