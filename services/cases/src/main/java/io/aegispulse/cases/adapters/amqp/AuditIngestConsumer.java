package io.aegispulse.cases.adapters.amqp;

import io.aegispulse.cases.service.AuditLogService;
import io.aegispulse.contracts.topology.QueueName;
import io.aegispulse.platform.amqp.EnvelopeHandler;
import io.aegispulse.platform.amqp.EnvelopeListeners;
import org.springframework.amqp.rabbit.listener.SimpleMessageListenerContainer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * cases.audit-ingest.q consumer adapter (FR-AUD-02): the kit validates the envelope, then this
 * calls the one service action; the kit acks, retries or dead-letters. No logic here.
 */
@Configuration
class AuditIngestConsumer {
  @Bean
  SimpleMessageListenerContainer auditIngestListener(
      EnvelopeListeners listeners, AuditLogService audit) {
    return listeners.container(
        QueueName.CASES_AUDIT_INGEST_Q,
        (envelope, ctx) ->
            audit.ingestAuditEvent(envelope)
                ? EnvelopeHandler.Outcome.PROCESSED
                : EnvelopeHandler.Outcome.DUPLICATE);
  }
}
