package io.aegispulse.registry.it;

import com.networknt.schema.Schema;
import com.networknt.schema.SchemaLocation;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;
import com.rabbitmq.client.Channel;
import com.rabbitmq.client.Connection;
import com.rabbitmq.client.GetResponse;
import io.aegispulse.contracts.envelope.CanonicalEnvelope;
import io.aegispulse.platform.amqp.EnvelopeCodec;
import io.aegispulse.registry.domain.PlatformTenant;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Predicate;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Tag;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Shared Spring context + HTTP/AMQP helpers for the registry integration suites (slice 2a). */
@Tag("integration")
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = "AEGIS_ENV=local") // read by the JSON log formatter before dynamic properties
@Import(RegistryIt.TestBeans.class)
abstract class RegistryIt {
  static final JsonMapper JSON = JsonMapper.builder().build();
  static final HttpClient HTTP = HttpClient.newHttpClient();
  static final UUID PLATFORM_ADMIN_ID = UUID.randomUUID();

  @LocalServerPort int port;
  @Autowired EnvelopeCodec codec;

  /**
   * Controllable clock (expiry, grace windows, key retirement); reset by each test that moves it.
   */
  static final class TestClock extends Clock {
    private volatile Duration offset = Duration.ZERO;

    void advance(Duration d) {
      offset = offset.plus(d);
    }

    void reset() {
      offset = Duration.ZERO;
    }

    @Override
    public ZoneId getZone() {
      return ZoneOffset.UTC;
    }

    @Override
    public Clock withZone(ZoneId zone) {
      return this;
    }

    @Override
    public Instant instant() {
      return Instant.now().plus(offset);
    }
  }

  static final TestClock CLOCK = new TestClock();
  static final String GATEWAY_SECRET = Infra.secret();

  @TestConfiguration
  static class TestBeans {
    @Bean
    @Primary
    Clock testClock() {
      return CLOCK;
    }
  }

  /** The same §10.4 variable names the image reads; application.yaml maps them. */
  @DynamicPropertySource
  static void properties(DynamicPropertyRegistry r) {
    r.add("PG_HOST", Infra.POSTGRES::getHost);
    r.add("PG_PORT", () -> Infra.POSTGRES.getMappedPort(5432));
    r.add("PG_DATABASE", () -> "aegispulse");
    r.add("PG_USER", () -> "svc_registry");
    r.add("PG_PASSWORD", Infra::svcPassword);
    r.add(
        "AMQP_URL",
        () ->
            "amqp://"
                + Infra.RUNTIME_USER
                + ":"
                + Infra.RUNTIME_PASSWORD
                + "@"
                + Infra.RABBIT.getHost()
                + ":"
                + Infra.RABBIT.getAmqpPort());
    r.add("REDIS_URL", Infra::redisUrl);
    r.add("REGISTRY_URL", () -> "http://127.0.0.1:1"); // the registry verifies in-process
    // Registered at startup exactly as in production; Tokens signs test tokens with the same key.
    r.add("JWT_SIGNING_KEY_CURRENT_PEM", Tokens::privatePem);
    r.add("JWT_SIGNING_KEY_CURRENT_KID", Tokens.KEY::getKeyID);
    r.add("SERVICE_CLIENT_SECRET_GATEWAY", () -> GATEWAY_SECRET);
    r.add("JWT_ISSUER", () -> Tokens.ISSUER);
    r.add("JWT_AUDIENCE", () -> "aegispulse");
  }

  record Reply(int status, JsonNode body) {
    JsonNode data() {
      return body.get("data");
    }

    String code() {
      return body.path("error").path("code").asString();
    }
  }

  static String paToken() {
    return Tokens.user(PLATFORM_ADMIN_ID, PlatformTenant.ID, PlatformTenant.SLUG, "PLATFORM_ADMIN");
  }

  Reply post(String action, @Nullable String token, Object body, String... headers) {
    HttpRequest.Builder b =
        HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/internal/v1/" + action))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body)));
    if (token != null) {
      b.header("Authorization", "Bearer " + token);
    }
    for (int i = 0; i < headers.length; i += 2) {
      b.header(headers[i], headers[i + 1]);
    }
    try {
      HttpResponse<String> r = HTTP.send(b.build(), HttpResponse.BodyHandlers.ofString());
      return new Reply(r.statusCode(), JSON.readTree(r.body().isEmpty() ? "{}" : r.body()));
    } catch (java.io.IOException e) {
      throw new IllegalStateException(e);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException(e);
    }
  }

  static final String STRONG = "violet-Harbor-71-quartz!";

  /** The gateway's real SERVICE token, obtained through client credentials (FR-AUTH-04). */
  String gatewayToken() {
    Reply r =
        post(
            "issueClientCredentialsToken",
            null,
            Map.of(
                "clientId", "svc-gateway",
                "clientSecret", GATEWAY_SECRET,
                "audience", "aegispulse-internal"));
    if (r.status() != 200) {
      throw new IllegalStateException("gateway token " + r);
    }
    return r.data().get("accessToken").asString();
  }

  Reply login(String slug, String email, String password) {
    return post(
        "login", gatewayToken(), Map.of("tenantSlug", slug, "email", email, "password", password));
  }

  static com.nimbusds.jwt.SignedJWT jwt(String token) {
    try {
      return com.nimbusds.jwt.SignedJWT.parse(token);
    } catch (java.text.ParseException e) {
      throw new IllegalStateException(e);
    }
  }

  static Map<String, Object> claims(String token) {
    try {
      return jwt(token).getJWTClaimsSet().getClaims();
    } catch (java.text.ParseException e) {
      throw new IllegalStateException(e);
    }
  }

  /** Creates an ACTIVE tenant as PLATFORM_ADMIN and returns its id. */
  UUID createTenant(String slug) {
    Reply r =
        post(
            "createTenant",
            paToken(),
            Map.of("slug", slug, "displayName", "Tenant " + slug),
            "Idempotency-Key",
            "create-" + slug);
    if (r.status() != 201) {
      throw new IllegalStateException("createTenant " + r);
    }
    return UUID.fromString(r.data().get("id").asString());
  }

  /**
   * PLATFORM_ADMIN creates a tenant's first TENANT_ADMIN via X-Aegis-Tenant; returns the user id.
   */
  UUID createFirstAdmin(UUID tenantId, String email) {
    Reply r =
        post(
            "createUser",
            paToken(),
            Map.of(
                "email",
                email,
                "displayName",
                "First Admin",
                "roles",
                List.of("TENANT_ADMIN"),
                "initialPassword",
                "violet-Harbor-71-quartz!"),
            "X-Aegis-Tenant",
            tenantId.toString());
    if (r.status() != 201) {
      throw new IllegalStateException("createUser " + r);
    }
    return UUID.fromString(r.data().get("id").asString());
  }

  private static final SchemaRegistry SCHEMAS =
      SchemaRegistry.withDefaultDialect(
          SpecificationVersion.DRAFT_2020_12,
          b ->
              b.schemaLoader(l ->
                  l.fetchRemoteResources()
                      .schemaIdResolvers(r ->
                          r.mapPrefix(
                              "https://aegispulse.dev/contracts/",
                              Infra.REPO.resolve("packages/contracts").toUri().toString()))));

  /** The payload must satisfy packages/contracts/events/{eventType}.v1.schema.json (§6.7). */
  static void assertPayloadMatchesContract(CanonicalEnvelope e) {
    Schema schema =
        SCHEMAS.getSchema(
            SchemaLocation.of(
                "https://aegispulse.dev/contracts/events/" + e.eventType() + ".v1.schema.json"));
    List<com.networknt.schema.Error> errors = schema.validate(JSON.valueToTree(e.payload()));
    if (!errors.isEmpty()) {
      throw new AssertionError(e.eventType() + " payload violates its contract: " + errors);
    }
  }

  /** Every envelope drained from cases.audit-ingest.q so far (shared across suites). */
  private static final List<CanonicalEnvelope> SEEN = new ArrayList<>();

  /**
   * Drains cases.audit-ingest.q (registry.# binding) until {@code count} envelopes matching {@code
   * match} have been seen; every envelope is schema-validated by the platform codec.
   */
  List<CanonicalEnvelope> awaitEvents(Predicate<CanonicalEnvelope> match, int count) {
    Instant deadline = Instant.now().plus(Duration.ofSeconds(20));
    try (Connection c = Infra.adminConnection();
        Channel ch = c.createChannel()) {
      while (Instant.now().isBefore(deadline)) {
        synchronized (SEEN) {
          List<CanonicalEnvelope> found = SEEN.stream().filter(match).toList();
          if (found.size() >= count) {
            return found;
          }
        }
        GetResponse g = ch.basicGet("cases.audit-ingest.q", true);
        if (g == null) {
          Thread.sleep(100);
          continue;
        }
        CanonicalEnvelope e = codec.decode(g.getBody());
        assertPayloadMatchesContract(e);
        synchronized (SEEN) {
          SEEN.add(e);
        }
      }
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
    synchronized (SEEN) {
      return SEEN.stream().filter(match).toList();
    }
  }
}
