package io.aegispulse.platform.amqp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.aegispulse.contracts.envelope.CanonicalEnvelope;
import io.aegispulse.platform.errors.ConsumerFailure.PoisonMessageException;
import java.io.IOException;
import java.io.InputStream;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Objects;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import tools.jackson.databind.json.JsonMapper;

/**
 * The Java envelope suite (Phase 1 contracts workstream): the same examples the TS and Python
 * suites use.
 */
class EnvelopeCodecTest {
  private static final EnvelopeCodec CODEC = new EnvelopeCodec(JsonMapper.builder().build());

  static List<Path> examples(String kind) throws IOException, URISyntaxException {
    URL dir =
        Objects.requireNonNull(
            EnvelopeCodecTest.class
                .getClassLoader()
                .getResource("aegispulse/contracts/envelope/examples/" + kind));
    try (Stream<Path> files = Files.list(Path.of(dir.toURI()))) {
      return files.filter(p -> p.toString().endsWith(".json")).sorted().toList();
    }
  }

  static List<Path> valid() throws IOException, URISyntaxException {
    return examples("valid");
  }

  static List<Path> invalid() throws IOException, URISyntaxException {
    return examples("invalid");
  }

  @ParameterizedTest
  @MethodSource("valid")
  void acceptsValidExamplesAndBindsTheGeneratedRecord(Path example) throws IOException {
    CanonicalEnvelope e = CODEC.decode(Files.readAllBytes(example));
    assertThat(e.schemaVersion()).startsWith("1.");
    assertThat(e.classification().sensitivity()).isNotNull();
  }

  @ParameterizedTest
  @MethodSource("invalid")
  void rejectsInvalidExamplesAsPoison_FR_EVT_01(Path example) throws IOException {
    byte[] body = Files.readAllBytes(example);
    assertThatThrownBy(() -> CODEC.decode(body))
        .isInstanceOf(PoisonMessageException.class)
        .satisfies(
            t -> assertThat(((PoisonMessageException) t).code()).isEqualTo("ENVELOPE_INVALID"));
  }

  @Test
  void rejectsNonJson() {
    assertThatThrownBy(
            () -> CODEC.decode("{not json".getBytes(java.nio.charset.StandardCharsets.UTF_8)))
        .isInstanceOf(PoisonMessageException.class)
        .hasMessage("message body is not JSON");
  }

  @Test
  void suiteIsNotEmpty() throws IOException, URISyntaxException {
    assertThat(valid()).hasSizeGreaterThanOrEqualTo(2);
    assertThat(invalid()).hasSizeGreaterThanOrEqualTo(6);
    try (InputStream schema =
        getClass().getClassLoader().getResourceAsStream(EnvelopeCodec.SCHEMA_RESOURCE)) {
      assertThat(schema).isNotNull();
    }
  }
}
