package io.aegispulse.platform.amqp;

import io.aegispulse.contracts.topology.Topology.QueuePolicy;
import io.aegispulse.platform.errors.ConsumerFailure;
import org.jspecify.annotations.Nullable;

/** Where a failed delivery goes (FR-MSG-01, NFR-10). Pure decision. */
public record FailureRoute(Action action, @Nullable String routingKey) {

  /**
   * RETRY → aegispulse.retry/{queue}.retry.{tier}; DEAD_LETTER → aegispulse.dlx/{queue}; REQUEUE
   * when no DLQ.
   */
  public enum Action {
    RETRY,
    DEAD_LETTER,
    REQUEUE
  }

  public static FailureRoute decide(
      QueuePolicy policy, int retryCount, ConsumerFailure.Classified failure) {
    if (failure.kind() == ConsumerFailure.Kind.TRANSIENT
        && retryCount < policy.retryTiers().size()) {
      return new FailureRoute(
          Action.RETRY,
          policy.queue().wireName() + ".retry." + policy.retryTiers().get(retryCount));
    }
    return policy.deadLetter()
        ? new FailureRoute(Action.DEAD_LETTER, policy.queue().wireName())
        : new FailureRoute(Action.REQUEUE, null);
  }
}
