package io.aegispulse.platform.amqp;

import io.aegispulse.contracts.envelope.CanonicalEnvelope;
import io.aegispulse.contracts.topology.QueueName;
import org.jspecify.annotations.Nullable;

/** Calls exactly ONE service action for a delivery (dispatch layer; no business logic here). */
@FunctionalInterface
public interface EnvelopeHandler {

  /**
   * Return DUPLICATE when the service's dedup check found the message already processed; it is
   * acked either way.
   */
  enum Outcome {
    PROCESSED,
    DUPLICATE
  }

  /** Delivery metadata for dedup (NFR-02) and logging. */
  record DeliveryContext(
      QueueName queue,
      int retryCount,
      int replayGeneration,
      @Nullable String replayJob,
      boolean redelivered) {}

  Outcome handle(CanonicalEnvelope envelope, DeliveryContext context) throws Exception;
}
