package io.aegispulse.platform.amqp;

import com.networknt.schema.Error;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;
import io.aegispulse.contracts.envelope.CanonicalEnvelope;
import io.aegispulse.platform.errors.ConsumerFailure.PoisonMessageException;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * Parses and validates canonical envelopes against the contract JSON Schema (FR-EVT-01): non-JSON,
 * schema-invalid or unknown-major envelopes are POISON with {@code ENVELOPE_INVALID}.
 */
public final class EnvelopeCodec {
  public static final String SCHEMA_RESOURCE =
      "aegispulse/contracts/envelope/canonical-envelope.v1.schema.json";
  public static final String ENVELOPE_INVALID = "ENVELOPE_INVALID";

  private final JsonMapper json;
  private final Schema schema;
  private final Set<String> requiredTopLevel;

  public EnvelopeCodec(JsonMapper json) {
    this.json = json;
    try (InputStream in =
        EnvelopeCodec.class.getClassLoader().getResourceAsStream(SCHEMA_RESOURCE)) {
      if (in == null) {
        throw new IllegalStateException(
            "envelope schema missing from classpath: " + SCHEMA_RESOURCE);
      }
      JsonNode schemaNode = json.readTree(in);
      this.schema =
          SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12)
              .getSchema(schemaNode);
      Set<String> required = new HashSet<>();
      schemaNode.get("required").forEach(r -> required.add(r.asString()));
      this.requiredTopLevel = Set.copyOf(required);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  public CanonicalEnvelope decode(byte[] body) {
    JsonNode node;
    try {
      node = json.readTree(body);
    } catch (JacksonException e) {
      throw new PoisonMessageException(ENVELOPE_INVALID, "message body is not JSON");
    }
    List<Error> errors = schema.validate(node);
    if (!errors.isEmpty()) {
      Error first = errors.getFirst();
      throw new PoisonMessageException(
          ENVELOPE_INVALID,
          "envelope failed schema validation at "
              + first.getInstanceLocation()
              + " ("
              + first.getKeyword()
              + ")");
    }
    try {
      return json.treeToValue(node, CanonicalEnvelope.class);
    } catch (JacksonException e) {
      throw new PoisonMessageException(ENVELOPE_INVALID, "envelope could not be bound");
    }
  }

  /**
   * Serializes for the wire. Records carry absent optional fields as null, but the closed envelope
   * schema only allows null where it says so, so null optional members are omitted (top level
   * except the required nullable ids, and the whole classification object). The payload is written
   * as given: its schema owns its nulls.
   */
  public byte[] encode(CanonicalEnvelope envelope) {
    ObjectNode node = json.valueToTree(envelope);
    pruneNulls(node, requiredTopLevel);
    JsonNode classification = node.get("classification");
    if (classification instanceof ObjectNode c) {
      pruneNulls(c, Set.of());
    }
    return json.writeValueAsBytes(node);
  }

  private static void pruneNulls(ObjectNode node, Set<String> keep) {
    List<String> nulls = new ArrayList<>();
    for (Map.Entry<String, JsonNode> e : node.properties()) {
      if (e.getValue().isNull() && !keep.contains(e.getKey())) {
        nulls.add(e.getKey());
      }
    }
    node.remove(nulls);
  }
}
