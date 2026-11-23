package io.aegispulse.platform.contracts;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.aegispulse.contracts.envelope.CanonicalEnvelope;
import io.aegispulse.contracts.envelope.Severity;
import io.aegispulse.contracts.events.ClassificationFinalizedPayload;
import io.aegispulse.contracts.events.EventTypes;
import io.aegispulse.contracts.topology.ExchangeName;
import io.aegispulse.contracts.topology.QueueName;
import io.aegispulse.contracts.topology.Topology;
import io.aegispulse.platform.amqp.EnvelopeCodec;
import java.io.IOException;
import java.io.InputStream;
import java.util.Objects;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/**
 * Generated Java records (make contracts) bind the wire format, including snake_case severity
 * lineage.
 */
class GeneratedContractsTest {
  private final JsonMapper json = JsonMapper.builder().build();

  @Test
  void envelopeAndPayloadRecordsBindTheWireFormat() throws IOException {
    byte[] body;
    try (InputStream in =
        Objects.requireNonNull(
            getClass()
                .getClassLoader()
                .getResourceAsStream(
                    "aegispulse/contracts/envelope/examples/valid/classification-finalized.json"))) {
      body = in.readAllBytes();
    }
    CanonicalEnvelope envelope = new EnvelopeCodec(json).decode(body);
    assertThat(envelope.eventType()).isEqualTo("classification.finalized");
    assertThat(envelope.classification().final_severity()).isInstanceOf(Severity.class);
    ClassificationFinalizedPayload payload =
        json.convertValue(envelope.payload(), ClassificationFinalizedPayload.class);
    assertThat(payload.eventId()).isNotBlank();
    assertThat(EventTypes.PAYLOADS)
        .hasSize(38)
        .containsEntry("classification.finalized", ClassificationFinalizedPayload.class);
  }

  @Test
  void encodeOmitsNullOptionalFieldsSoTheEnvelopeStaysSchemaValid() throws IOException {
    EnvelopeCodec codec = new EnvelopeCodec(json);
    byte[] body;
    try (InputStream in =
        Objects.requireNonNull(
            getClass()
                .getClassLoader()
                .getResourceAsStream(
                    "aegispulse/contracts/envelope/examples/valid/classification-finalized.json"))) {
      body = in.readAllBytes();
    }
    CanonicalEnvelope decoded = codec.decode(body);
    CanonicalEnvelope roundTrip =
        codec.decode(codec.encode(decoded)); // would be POISON if nulls leaked
    assertThat(roundTrip.eventId()).isEqualTo(decoded.eventId());
    assertThat(json.readTree(codec.encode(decoded)).has("causationId"))
        .isTrue(); // required nullable stays
  }

  @Test
  void topologyConstantsMirrorTheContract() {
    assertThat(ExchangeName.values()).hasSize(6);
    assertThat(Topology.RETRY_EXCHANGE.wireName()).isEqualTo("aegispulse.retry");
    assertThat(Topology.DEAD_LETTER_EXCHANGE.wireName()).isEqualTo("aegispulse.dlx");
    assertThat(QueueName.values()).hasSize(58);
    assertThat(Topology.WORK_QUEUES).hasSize(13);
    assertThat(Topology.policy(QueueName.FILES_VALIDATION_Q))
        .isEqualTo(
            new Topology.QueuePolicy(
                QueueName.FILES_VALIDATION_Q, 4, java.util.List.of("1s", "5s", "30s"), true));
    assertThat(QueueName.fromWireName("files.validation.q"))
        .isEqualTo(QueueName.FILES_VALIDATION_Q);
    assertThatThrownBy(() -> QueueName.fromWireName("nope.q"))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> Topology.policy(QueueName.FILES_VALIDATION_Q_DLQ))
        .isInstanceOf(IllegalArgumentException.class);
  }
}
