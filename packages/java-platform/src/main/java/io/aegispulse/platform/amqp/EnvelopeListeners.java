package io.aegispulse.platform.amqp;

import io.aegispulse.contracts.topology.QueueName;
import io.aegispulse.contracts.topology.Topology;
import io.aegispulse.contracts.topology.Topology.QueuePolicy;
import io.micrometer.core.instrument.MeterRegistry;
import org.jspecify.annotations.Nullable;
import org.springframework.amqp.core.AcknowledgeMode;
import org.springframework.amqp.rabbit.connection.ConnectionFactory;
import org.springframework.amqp.rabbit.listener.SimpleMessageListenerContainer;

/**
 * Builds a manual-ack listener container for one work queue, with the contract prefetch, passive
 * queue check only (a missing queue fails startup; nothing is declared) and a 20 s drain on
 * shutdown (NFR-11). Register the result as a bean so Spring stops it gracefully.
 */
public final class EnvelopeListeners {
  private final ConnectionFactory connectionFactory;
  private final EnvelopeCodec codec;
  private final AmqpEnvelopePublisher publisher;
  private final @Nullable MeterRegistry meters;

  public EnvelopeListeners(
      ConnectionFactory connectionFactory,
      EnvelopeCodec codec,
      AmqpEnvelopePublisher publisher,
      @Nullable MeterRegistry meters) {
    this.connectionFactory = connectionFactory;
    this.codec = codec;
    this.publisher = publisher;
    this.meters = meters;
  }

  public SimpleMessageListenerContainer container(QueueName queue, EnvelopeHandler handler) {
    QueuePolicy policy = Topology.policy(queue);
    SimpleMessageListenerContainer container =
        new SimpleMessageListenerContainer(connectionFactory);
    container.setQueueNames(queue.wireName());
    container.setAcknowledgeMode(AcknowledgeMode.MANUAL);
    container.setPrefetchCount(policy.prefetch());
    container.setMissingQueuesFatal(true);
    container.setAutoDeclare(false);
    container.setDefaultRequeueRejected(true);
    container.setShutdownTimeout(20_000);
    container.setMessageListener(new EnvelopeListener(policy, handler, codec, publisher, meters));
    return container;
  }
}
