package io.aegispulse.platform.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.rabbitmq.client.AMQP;
import com.rabbitmq.client.Channel;
import com.rabbitmq.client.Connection;
import com.rabbitmq.client.GetResponse;
import com.sun.net.httpserver.HttpServer;
import io.aegispulse.contracts.envelope.CanonicalEnvelope;
import io.aegispulse.platform.db.TenantScope;
import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.platform.idempotency.IdempotencyRepository;
import io.aegispulse.platform.idempotency.ProcessedMessagesRepository;
import io.aegispulse.platform.outbox.OutboxMessage;
import io.aegispulse.platform.outbox.OutboxRelay;
import io.aegispulse.platform.outbox.OutboxRepository;
import io.aegispulse.platform.security.JwtFixtures;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeoutException;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.amqp.rabbit.listener.SimpleMessageListenerContainer;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * java-platform end to end (Phase 1c): probes, JWT/act[] + §8.2 envelopes, outbox → confirmed
 * publish → consumer kit, retry through the real TTL queue, DLQ, dedup, idempotency under RLS,
 * graceful drain. Real PostgreSQL 18 (as svc_cases) and RabbitMQ 4 (runtime user with configure
 * '^$').
 */
@Tag("integration")
@SpringBootTest(
    classes = TestApplication.class,
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class PlatformIntegrationTest {
  private static final String QUEUE = "cases.audit-ingest.q";
  private static final JwtFixtures KEYS = new JwtFixtures();
  private static final HttpServer JWKS;
  private static final JsonMapper JSON = JsonMapper.builder().build();
  private static final HttpClient HTTP = HttpClient.newHttpClient();

  static {
    try {
      JWKS =
          HttpServer.create(new InetSocketAddress(java.net.InetAddress.getLoopbackAddress(), 0), 0);
    } catch (IOException e) {
      throw new IllegalStateException(e);
    }
    byte[] body = KEYS.publicJwks().toString().getBytes(StandardCharsets.UTF_8);
    JWKS.createContext(
        "/.well-known/jwks.json",
        exchange -> {
          exchange.getResponseHeaders().add("content-type", "application/json");
          exchange.sendResponseHeaders(200, body.length);
          exchange.getResponseBody().write(body);
          exchange.close();
        });
    JWKS.start();
  }

  @DynamicPropertySource
  static void properties(DynamicPropertyRegistry r) {
    r.add("spring.datasource.url", Infra.POSTGRES::getJdbcUrl);
    r.add("spring.datasource.username", () -> "svc_cases");
    r.add("spring.datasource.password", Infra::svcPassword);
    r.add("spring.rabbitmq.host", Infra.RABBIT::getHost);
    r.add("spring.rabbitmq.port", Infra.RABBIT::getAmqpPort);
    r.add("spring.rabbitmq.username", () -> Infra.RUNTIME_USER);
    r.add("spring.rabbitmq.password", () -> Infra.RUNTIME_PASSWORD);
    r.add("aegis.service", () -> "cases");
    r.add("aegis.version", () -> "test");
    r.add("aegis.env", () -> "local");
    r.add(
        "aegis.security.jwk-set-uri",
        () -> "http://127.0.0.1:" + JWKS.getAddress().getPort() + "/.well-known/jwks.json");
    r.add("aegis.security.issuer", () -> JwtFixtures.ISSUER);
    r.add("aegis.security.audience", () -> "aegispulse");
    r.add("aegis.readiness.schema", () -> "cases");
    r.add("aegis.readiness.min-flyway-version", () -> "1");
    r.add("aegis.outbox.schema", () -> "cases");
    r.add("aegis.outbox.poll-interval", () -> "1h"); // tests drive runOnce() explicitly
  }

  @LocalServerPort int port;
  @Autowired JdbcClient jdbc;
  @Autowired PlatformTransactionManager transactions;
  @Autowired OutboxRepository outbox;
  @Autowired OutboxRelay relay;
  @Autowired TenantScope tenantScope;
  @Autowired SimpleMessageListenerContainer auditIngestListener;

  private static Connection admin;
  private static Channel adminCh;

  @BeforeEach
  void reset() throws IOException, TimeoutException {
    if (admin == null) {
      admin = Infra.adminConnection();
      adminCh = admin.createChannel();
      adminCh.confirmSelect();
    }
    TestApplication.MODE.set(TestApplication.Mode.OK);
    TestApplication.RECEIVED.clear();
    TestApplication.FINISHED.clear();
    for (String q :
        List.of(
            QUEUE + ".dlq",
            "events.deadletter.q",
            "events.archive.q",
            QUEUE + ".retry.1s",
            QUEUE + ".retry.5s",
            QUEUE + ".retry.30s")) {
      adminCh.queuePurge(q);
    }
  }

  @AfterAll
  static void stopJwks() throws IOException, TimeoutException {
    JWKS.stop(0);
    if (admin != null) {
      admin.close();
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private static CanonicalEnvelope envelope(String eventType) {
    Map<String, Object> e = new HashMap<>();
    e.put("eventId", UUID.randomUUID().toString());
    e.put("correlationId", "corr-" + UUID.randomUUID());
    e.put("causationId", null);
    e.put("tenantId", UUID.randomUUID().toString());
    e.put("schemaVersion", "1.1.0");
    e.put("eventType", eventType);
    e.put("source", "service:registry");
    e.put("producer", "aegispulse-registry@abc1234");
    e.put("occurredAt", Instant.now().toString());
    e.put("ingestedAt", Instant.now().toString());
    e.put("idempotencyKey", "registry:" + UUID.randomUUID());
    e.put("classification", Map.of("sensitivity", "INTERNAL", "status", "INGESTED"));
    e.put("payload", examplePayload(eventType));
    return JSON.convertValue(e, CanonicalEnvelope.class);
  }

  private static Object examplePayload(String eventType) {
    try (InputStream in =
        new java.io.FileInputStream(
            Infra.REPO
                .resolve("packages/contracts/events/examples/" + eventType + ".json")
                .toFile())) {
      return JSON.readValue(in, Map.class);
    } catch (IOException ex) {
      throw new IllegalStateException(ex);
    }
  }

  private static void publish(byte[] body, Map<String, Object> headers) throws Exception {
    AMQP.BasicProperties props =
        new AMQP.BasicProperties.Builder()
            .contentType("application/json")
            .deliveryMode(2)
            .headers(headers)
            .build();
    adminCh.basicPublish("aegispulse.domain", "registry.tenant.created", true, props, body);
    adminCh.waitForConfirmsOrDie(5_000);
  }

  private static void publish(CanonicalEnvelope e, Map<String, Object> headers) throws Exception {
    publish(new io.aegispulse.platform.amqp.EnvelopeCodec(JSON).encode(e), headers);
  }

  private static void await(BooleanSupplier condition, Duration timeout)
      throws InterruptedException {
    long deadline = System.nanoTime() + timeout.toNanos();
    while (!condition.getAsBoolean()) {
      if (System.nanoTime() > deadline) {
        throw new AssertionError("condition not met within " + timeout);
      }
      Thread.sleep(50);
    }
  }

  private static GetResponse awaitMessage(String queue) throws Exception {
    long deadline = System.nanoTime() + Duration.ofSeconds(10).toNanos();
    while (System.nanoTime() < deadline) {
      GetResponse r = adminCh.basicGet(queue, true);
      if (r != null) {
        return r;
      }
      Thread.sleep(50);
    }
    throw new AssertionError("no message on " + queue);
  }

  private HttpResponse<String> post(String path, String token)
      throws IOException, InterruptedException {
    HttpRequest.Builder b =
        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
            .POST(HttpRequest.BodyPublishers.ofString("{}"))
            .header("content-type", "application/json");
    if (token != null) {
      b.header("authorization", "Bearer " + token);
    }
    return HTTP.send(b.build(), HttpResponse.BodyHandlers.ofString());
  }

  private HttpResponse<String> get(String path) throws IOException, InterruptedException {
    return HTTP.send(
        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).GET().build(),
        HttpResponse.BodyHandlers.ofString());
  }

  private <T> T inTx(java.util.function.Supplier<T> work) {
    return Objects.requireNonNull(new TransactionTemplate(transactions).execute(s -> work.get()));
  }

  // ── probes (NFR-11) ─────────────────────────────────────────────────────────

  @Test
  @Order(1)
  void probesAreOpenAndReadinessChecksDbBrokerAndSchemaVersion() throws Exception {
    HttpResponse<String> live = get("/livez");
    assertThat(live.statusCode()).isEqualTo(200);
    assertThat(JSON.readTree(live.body()).get("status").asString()).isEqualTo("UP");
    HttpResponse<String> ready = get("/readyz");
    assertThat(ready.statusCode()).isEqualTo(200);
    JsonNode health = JSON.readTree(get("/healthz").body());
    assertThat(health.get("components").has("flywaySchema")).isTrue();
    assertThat(health.get("components").has("rabbit")).isTrue();
    assertThat(health.get("components").has("db")).isTrue();
    assertThat(health.toString()).doesNotContain("password");
  }

  // ── auth (FR-AUTH-05, §5.7.4, §8.2) ─────────────────────────────────────────

  @Test
  @Order(2)
  void internalRoutesRequireUserOrServiceTokenWithAct() throws Exception {
    HttpResponse<String> none = post("/internal/v1/ping", null);
    assertThat(none.statusCode()).isEqualTo(401);
    JsonNode err = JSON.readTree(none.body());
    assertThat(err.get("error").get("code").asString()).isEqualTo("UNAUTHORIZED");
    String corr = none.headers().firstValue("X-Correlation-Id").orElseThrow();
    assertThat(corr).startsWith("corr-");
    assertThat(err.get("meta").get("correlationId").asString()).isEqualTo(corr);

    String user =
        KEYS.sign(JwtFixtures.userClaims(UUID.randomUUID().toString()), "aegispulse", "u-1");
    assertThat(
            JSON.readTree(post("/internal/v1/ping", user).body())
                .get("data")
                .get("kind")
                .asString())
        .isEqualTo("user");

    String allowed =
        KEYS.sign(
            Map.of("typ", "service", "act", List.of("cases.ping")),
            "aegispulse-internal",
            "svc-orchestrator");
    assertThat(post("/internal/v1/ping", allowed).statusCode()).isEqualTo(200);

    String denied =
        KEYS.sign(
            Map.of("typ", "service", "act", List.of("cases.openCase")),
            "aegispulse-internal",
            "svc-orchestrator");
    HttpResponse<String> forbidden = post("/internal/v1/ping", denied);
    assertThat(forbidden.statusCode()).isEqualTo(403);
    assertThat(JSON.readTree(forbidden.body()).get("error").get("code").asString())
        .isEqualTo("FORBIDDEN");

    String devToken =
        KEYS.sign(JwtFixtures.userClaims(UUID.randomUUID().toString()), "aegispulse-dev", "u-1");
    assertThat(post("/internal/v1/ping", devToken).statusCode()).isEqualTo(401);

    HttpResponse<String> missing = post("/internal/v1/missing", user);
    assertThat(missing.statusCode()).isEqualTo(404);
    assertThat(JSON.readTree(missing.body()).get("error").get("code").asString())
        .isEqualTo("NOT_FOUND");
  }

  // ── outbox (§6.6) ───────────────────────────────────────────────────────────

  @Test
  @Order(3)
  void outboxRowsCommitWithTheTransactionAndRelayPublishesWithConfirmsToTheConsumer()
      throws Exception {
    CanonicalEnvelope committed = envelope("registry.tenant.created");
    assertThat(
            inTx(() ->
                outbox.enqueue(
                    new OutboxMessage("aegispulse.domain", "registry.tenant.created", committed))))
        .isTrue();
    assertThat(
            inTx(() ->
                outbox.enqueue(
                    new OutboxMessage("aegispulse.domain", "registry.tenant.created", committed))))
        .isFalse();
    CanonicalEnvelope rolledBack = envelope("registry.tenant.created");
    assertThatThrownBy(() ->
            inTx(() -> {
              outbox.enqueue(
                  new OutboxMessage("aegispulse.domain", "registry.tenant.created", rolledBack));
              throw new IllegalStateException("state change failed");
            }))
        .hasMessage("state change failed");

    assertThat(relay.runOnce()).isEqualTo(1);
    assertThat(
            jdbc.sql("SELECT status FROM cases.outbox_events WHERE event_id = ?::uuid")
                .param(committed.eventId())
                .query(String.class)
                .single())
        .isEqualTo("SENT");
    assertThat(
            jdbc.sql("SELECT count(*) FROM cases.outbox_events WHERE event_id = ?::uuid")
                .param(rolledBack.eventId())
                .query(Long.class)
                .single())
        .isZero();
    await(() -> TestApplication.FINISHED.contains(committed.eventId()), Duration.ofSeconds(10));
    GetResponse archived = awaitMessage("events.archive.q");
    assertThat(archived.getProps().getMessageId()).isEqualTo(committed.eventId());
    assertThat(archived.getProps().getType()).isEqualTo("registry.tenant.created");
    assertThat(archived.getProps().getDeliveryMode()).isEqualTo(2);
    assertThat(archived.getProps().getHeaders())
        .containsKeys("x-aegis-tenant", "x-aegis-schema-version");
  }

  @Test
  @Order(4)
  void twoRelaysNeverPublishARowTwice() throws Exception {
    inTx(() -> {
      for (int i = 0; i < 150; i++) {
        outbox.enqueue(
            new OutboxMessage(
                "aegispulse.domain",
                "registry.tenant.created",
                envelope("registry.tenant.created")));
      }
      return true;
    });
    // A second relay instance (another replica) with a recording publisher: both must claim
    // disjoint rows.
    var publishedBySecond = new java.util.concurrent.ConcurrentLinkedQueue<String>();
    OutboxRelay other =
        new OutboxRelay(
            outbox,
            m -> publishedBySecond.add(m.envelope().eventId()),
            new TransactionTemplate(transactions),
            Duration.ofHours(1),
            40,
            null);
    int total = 0;
    while (true) {
      CompletableFuture<Integer> a = CompletableFuture.supplyAsync(relay::runOnce);
      CompletableFuture<Integer> b = CompletableFuture.supplyAsync(other::runOnce);
      int n = a.get() + b.get();
      total += n;
      if (n == 0) {
        break;
      }
    }
    assertThat(total).isEqualTo(150);
    int viaBroker = 150 - publishedBySecond.size();
    await(() -> TestApplication.FINISHED.size() >= viaBroker, Duration.ofSeconds(20));
    var seen = new HashSet<>(TestApplication.FINISHED);
    seen.addAll(publishedBySecond);
    assertThat(seen).hasSize(150);
    assertThat(TestApplication.FINISHED).doesNotHaveDuplicates();
  }

  @Test
  @Order(5)
  void failedPublishesBackOffAndFailAfterTwentyAttempts() {
    CanonicalEnvelope e = envelope("registry.tenant.created");
    inTx(
        () -> outbox.enqueue(new OutboxMessage("aegispulse.domain", "registry.tenant.created", e)));
    OutboxRelay failing =
        new OutboxRelay(
            outbox,
            m -> {
              throw new IllegalStateException("broker nacked");
            },
            new TransactionTemplate(transactions),
            Duration.ofHours(1),
            100,
            null);
    assertThat(failing.runOnce()).isEqualTo(1);
    Map<String, Object> row =
        jdbc.sql(
                "SELECT attempts, status, last_error, EXTRACT(EPOCH FROM available_at - now())::float8 AS delay FROM cases.outbox_events WHERE event_id = ?::uuid")
            .param(e.eventId())
            .query()
            .singleRow();
    assertThat(row)
        .containsEntry("attempts", 1)
        .containsEntry("status", "PENDING")
        .containsEntry("last_error", "IllegalStateException: broker nacked");
    assertThat((Double) row.get("delay")).isGreaterThan(0.5);
    assertThat(failing.runOnce()).isZero(); // not due yet
    UUID id =
        jdbc.sql("SELECT id FROM cases.outbox_events WHERE event_id = ?::uuid")
            .param(e.eventId())
            .query(UUID.class)
            .single();
    String status =
        inTx(() ->
            outbox.markFailed(
                new OutboxRepository.Row(
                    id,
                    UUID.fromString(e.eventId()),
                    null,
                    new OutboxMessage("aegispulse.domain", "registry.tenant.created", e),
                    19),
                "x"));
    assertThat(status).isEqualTo("FAILED");
    assertThat(outbox.purgeSent(0)).isGreaterThanOrEqualTo(151);
  }

  // ── consumer kit (FR-MSG-01) ────────────────────────────────────────────────

  @Test
  @Order(6)
  void retriesTransientThroughTheRealTtlQueueThenSucceeds() throws Exception {
    TestApplication.MODE.set(TestApplication.Mode.TRANSIENT_ONCE);
    CanonicalEnvelope e = envelope("registry.tenant.created");
    long started = System.nanoTime();
    publish(e, Map.of());
    await(() -> TestApplication.FINISHED.contains(e.eventId()), Duration.ofSeconds(15));
    assertThat(TestApplication.RECEIVED)
        .extracting(r -> r.context().retryCount())
        .containsExactly(0, 1);
    assertThat(Duration.ofNanos(System.nanoTime() - started)).isGreaterThan(Duration.ofMillis(900));
    assertThat(adminCh.messageCount(QUEUE + ".dlq")).isZero();
  }

  @Test
  @Order(7)
  void deadLettersPermanentPoisonAndExhaustedRetriesWithErrorHeaders() throws Exception {
    TestApplication.MODE.set(TestApplication.Mode.PERMANENT);
    CanonicalEnvelope e = envelope("registry.tenant.created");
    publish(e, Map.of());
    GetResponse dead = awaitMessage(QUEUE + ".dlq");
    assertThat(dead.getProps().getHeaders().get("x-aegis-error-code").toString())
        .isEqualTo("NOT_FOUND");
    assertThat(dead.getProps().getHeaders().get("x-aegis-original-queue").toString())
        .isEqualTo(QUEUE);
    assertThat(dead.getProps().getHeaders().get("x-aegis-error-message").toString())
        .isEqualTo("NotFound[NOT_FOUND]: case missing");
    assertThat(dead.getProps().getHeaders().get("x-aegis-error-stack-hash").toString())
        .matches("[0-9a-f]{16}");
    assertThat(JSON.readTree(dead.getBody()).get("eventId").asString()).isEqualTo(e.eventId());
    assertThat(awaitMessage("events.deadletter.q")).isNotNull();
    assertThat(TestApplication.RECEIVED).hasSize(1);

    TestApplication.RECEIVED.clear();
    publish("{not json".getBytes(StandardCharsets.UTF_8), Map.of());
    assertThat(
            awaitMessage(QUEUE + ".dlq")
                .getProps()
                .getHeaders()
                .get("x-aegis-error-code")
                .toString())
        .isEqualTo("ENVELOPE_INVALID");
    assertThat(TestApplication.RECEIVED).isEmpty();

    TestApplication.MODE.set(TestApplication.Mode.TRANSIENT_ALWAYS);
    publish(envelope("registry.tenant.created"), Map.of("x-retry-count", 3));
    GetResponse exhausted = awaitMessage(QUEUE + ".dlq");
    assertThat(exhausted.getProps().getHeaders().get("x-aegis-error-code").toString())
        .isEqualTo("DEPENDENCY_UNAVAILABLE");
  }

  @Test
  @Order(8)
  void passesReplayHeadersAndAcksDuplicates() throws Exception {
    TestApplication.MODE.set(TestApplication.Mode.DUPLICATE);
    publish(
        envelope("registry.tenant.created"),
        Map.of("x-aegis-replay-job", "job-1", "x-aegis-replay-generation", 2));
    await(() -> !TestApplication.RECEIVED.isEmpty(), Duration.ofSeconds(10));
    assertThat(TestApplication.RECEIVED.getFirst().context().replayGeneration()).isEqualTo(2);
    assertThat(TestApplication.RECEIVED.getFirst().context().replayJob()).isEqualTo("job-1");
    await(
        () -> {
          try {
            return adminCh.messageCount(QUEUE) == 0;
          } catch (IOException ex) {
            return false;
          }
        },
        Duration.ofSeconds(5));
  }

  // ── dedup + idempotency under RLS (NFR-02, NFR-06) ───────────────────────────

  @Test
  @Order(9)
  void processedMessagesDetectsRedeliveryButNotNewReplayGenerations() {
    ProcessedMessagesRepository processed = new ProcessedMessagesRepository(jdbc, "cases");
    UUID eventId = UUID.randomUUID();
    assertThat(inTx(() -> processed.markProcessed(QUEUE, eventId, 0))).isTrue();
    assertThat(inTx(() -> processed.markProcessed(QUEUE, eventId, 0))).isFalse();
    assertThat(inTx(() -> processed.markProcessed(QUEUE, eventId, 1))).isTrue();
  }

  @Test
  @Order(10)
  void idempotencyFailsClosedWithoutTenantScopeAndIsolatesTenants() {
    IdempotencyRepository idem = new IdempotencyRepository(jdbc, "cases");
    UUID tenantA = UUID.randomUUID();
    UUID tenantB = UUID.randomUUID();
    String sha = IdempotencyRepository.sha256Hex("{\"a\":1}");
    assertThatThrownBy(() -> inTx(() -> idem.begin(tenantA, "openCase", "key-1", sha)))
        .isInstanceOf(org.springframework.dao.DataAccessException.class)
        .rootCause()
        .hasMessageContaining("row-level security");
    assertThatThrownBy(() -> tenantScope.apply(tenantA))
        .isInstanceOf(IllegalStateException.class); // no tx

    assertThat(
            inTx(() -> {
              tenantScope.apply(tenantA);
              IdempotencyRepository.Decision d = idem.begin(tenantA, "openCase", "key-1", sha);
              idem.complete(tenantA, "openCase", "key-1", 201, "{\"caseId\":\"c-1\"}");
              return d;
            }))
        .isInstanceOf(IdempotencyRepository.Decision.New.class);
    assertThat(
            inTx(() -> {
              tenantScope.apply(tenantA);
              return idem.begin(tenantA, "openCase", "key-1", sha);
            }))
        .isEqualTo(new IdempotencyRepository.Decision.Replay(201, "{\"caseId\": \"c-1\"}"));
    assertThatThrownBy(() ->
            inTx(() -> {
              tenantScope.apply(tenantA);
              return idem.begin(
                  tenantA, "openCase", "key-1", IdempotencyRepository.sha256Hex("other"));
            }))
        .isInstanceOfSatisfying(
            DomainException.Conflict.class,
            c -> assertThat(c.code()).isEqualTo("IDEMPOTENCY_KEY_REUSED"));
    // tenant B: same key is independent; A's rows are invisible; writing A's row while scoped to B
    // is refused
    assertThat(
            inTx(() -> {
              tenantScope.apply(tenantB);
              return idem.begin(tenantB, "openCase", "key-1", sha);
            }))
        .isInstanceOf(IdempotencyRepository.Decision.New.class);
    assertThat(
            inTx(() -> {
              tenantScope.apply(tenantB);
              return jdbc.sql("SELECT count(*) FROM cases.idempotency_records WHERE tenant_id = ?")
                  .param(tenantA)
                  .query(Long.class)
                  .single();
            }))
        .isZero();
    assertThatThrownBy(() ->
            inTx(() -> {
              tenantScope.apply(tenantB);
              return idem.begin(tenantA, "openCase", "key-2", sha);
            }))
        .rootCause()
        .hasMessageContaining("row-level security");
    // ADR-0016: the old session setting no longer lifts RLS ...
    assertThat(
            inTx(() -> {
              jdbc.sql("SELECT set_config('app.bypass_rls', 'on', true)").query().singleValue();
              return jdbc.sql("SELECT count(*) FROM cases.idempotency_records")
                  .query(Long.class)
                  .single();
            }))
        .isZero();
    // ... and cross-tenant retention runs only through the SECURITY DEFINER function.
    for (UUID tenant : List.of(tenantA, tenantB)) {
      inTx(() -> {
        tenantScope.apply(tenant);
        return jdbc.sql(
                "UPDATE cases.idempotency_records SET expires_at = now() - interval '1 hour'")
            .update();
      });
    }
    assertThat(inTx(idem::purgeExpired)).isEqualTo(2); // tenant A key-1 + tenant B key-1
  }

  // ── graceful shutdown (NFR-11) — last: stops the listener ───────────────────

  @Test
  @Order(11)
  void walksTheFullRetryChainWithIncreasingDelaysThenDeadLetters_FR_MSG_01() throws Exception {
    TestApplication.MODE.set(TestApplication.Mode.TRANSIENT_ALWAYS);
    publish(envelope("registry.tenant.created"), Map.of());
    await(() -> TestApplication.RECEIVED.size() == 4, Duration.ofSeconds(60));
    List<TestApplication.Received> seen = List.copyOf(TestApplication.RECEIVED);
    assertThat(seen).extracting(r -> r.context().retryCount()).containsExactly(0, 1, 2, 3);
    long[] gapsMs = new long[3];
    for (int i = 0; i < 3; i++) {
      gapsMs[i] = (seen.get(i + 1).atNanos() - seen.get(i).atNanos()) / 1_000_000;
    }
    assertThat(gapsMs[0]).isGreaterThanOrEqualTo(900);
    assertThat(gapsMs[1]).isGreaterThanOrEqualTo(4_500).isGreaterThan(gapsMs[0]);
    assertThat(gapsMs[2]).isGreaterThanOrEqualTo(29_000).isGreaterThan(gapsMs[1]);
    GetResponse dead = awaitMessage(QUEUE + ".dlq");
    assertThat(dead.getProps().getHeaders().get("x-aegis-error-code").toString())
        .isEqualTo("DEPENDENCY_UNAVAILABLE");
    assertThat(dead.getProps().getHeaders().get("x-retry-count").toString()).isEqualTo("3");
  }

  @Test
  @Order(12)
  void requeuesTheOriginalWhenTheDeadLetterRepublishFails_FR_MSG_01() throws Exception {
    // The DLX disappears after the listener started: the DLQ copy is never confirmed, so the
    // original is nack-requeued and redelivered instead of being lost.
    TestApplication.MODE.set(TestApplication.Mode.PERMANENT_ONCE);
    adminCh.exchangeDelete("aegispulse.dlx");
    try {
      publish(envelope("registry.tenant.created"), Map.of());
      await(() -> TestApplication.FINISHED.size() == 1, Duration.ofSeconds(30));
      assertThat(TestApplication.RECEIVED)
          .extracting(r -> r.context().redelivered())
          .containsExactly(false, true);
    } finally {
      adminCh.exchangeDeclare("aegispulse.dlx", "topic", true);
      adminCh.queueBind(QUEUE + ".dlq", "aegispulse.dlx", QUEUE);
      adminCh.queueBind("events.deadletter.q", "aegispulse.dlx", "#");
    }
    assertThat(adminCh.messageCount(QUEUE + ".dlq")).isZero();
  }

  @Test
  @Order(99)
  void stoppingTheListenerWaitsForTheInFlightHandlerAndAcks() throws Exception {
    TestApplication.MODE.set(TestApplication.Mode.SLOW);
    CanonicalEnvelope e = envelope("registry.tenant.created");
    publish(e, Map.of());
    await(() -> !TestApplication.RECEIVED.isEmpty(), Duration.ofSeconds(10));
    auditIngestListener.stop();
    assertThat(TestApplication.FINISHED).contains(e.eventId());
    // The acked message must not come back: give the broker's queue stats a moment, then look at
    // what is left.
    Thread.sleep(1_000);
    GetResponse leftover = adminCh.basicGet(QUEUE, true);
    assertThat(
            leftover == null
                ? null
                : new String(leftover.getBody(), StandardCharsets.UTF_8)
                    + " redelivered="
                    + leftover.getEnvelope().isRedeliver())
        .as("message left on the queue after graceful stop")
        .isNull();
    assertThat(adminCh.queueDeclarePassive(QUEUE).getConsumerCount()).isZero();
  }
}
