package io.aegispulse.cases.it;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sun.net.httpserver.HttpServer;
import io.aegispulse.cases.db.AuditRepository;
import io.aegispulse.cases.domain.AuditHash;
import io.aegispulse.cases.domain.CaseStatus;
import io.aegispulse.cases.service.Actor;
import io.aegispulse.cases.service.AuditService;
import io.aegispulse.cases.service.CaseService;
import io.aegispulse.platform.db.TenantScope;
import io.aegispulse.platform.errors.DomainException;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
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
 * FR-TXN-05/06, FR-CASE-01/02/03/07, FR-AUD-01 against real PostgreSQL 18 (svc_cases: RLS, no
 * UPDATE/DELETE on history, append-only audit log) through the internal HTTP actions.
 */
@Tag("integration")
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = "AEGIS_ENV=local")
class CasesIT {
  static final JsonMapper JSON = JsonMapper.builder().build();
  static final HttpClient HTTP = HttpClient.newHttpClient();
  static final HttpServer JWKS;
  static final String SAGA =
      Tokens.service("svc-orchestrator", "cases.recordRiskEvaluation", "cases.openCase");

  static {
    try {
      JWKS =
          HttpServer.create(new InetSocketAddress(java.net.InetAddress.getLoopbackAddress(), 0), 0);
    } catch (IOException e) {
      throw new IllegalStateException(e);
    }
    byte[] body = Tokens.publicJwks().toString().getBytes(StandardCharsets.UTF_8);
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
    r.add("PG_HOST", Infra.POSTGRES::getHost);
    r.add("PG_PORT", () -> Infra.POSTGRES.getMappedPort(5432));
    r.add("PG_DATABASE", () -> "aegispulse");
    r.add("PG_USER", () -> "svc_cases");
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
    r.add("REGISTRY_URL", () -> "http://127.0.0.1:" + JWKS.getAddress().getPort());
    r.add("JWT_ISSUER", () -> Tokens.ISSUER);
    r.add("JWT_AUDIENCE", () -> "aegispulse");
    r.add("aegis.outbox.poll-interval", () -> "1h"); // outbox rows are asserted in the DB
  }

  @AfterAll
  static void stop() {
    JWKS.stop(0);
  }

  @LocalServerPort int port;
  @Autowired JdbcClient jdbc;
  @Autowired PlatformTransactionManager tx;
  @Autowired TenantScope scope;
  @Autowired CaseService cases;
  @Autowired AuditService audit;
  @Autowired AuditRepository auditRepo;

  record Reply(int status, JsonNode body) {
    JsonNode data() {
      return body.get("data");
    }

    String code() {
      return body.path("error").path("code").asString();
    }
  }

  Reply post(String action, String token, Object body) throws IOException, InterruptedException {
    return post(action, token, body, null);
  }

  Reply post(String action, String token, Object body, String acting)
      throws IOException, InterruptedException {
    HttpRequest.Builder b =
        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/internal/v1/" + action))
            .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body)))
            .header("content-type", "application/json")
            .header("authorization", "Bearer " + token);
    if (acting != null) {
      b.header("X-Aegis-Tenant", acting);
    }
    HttpResponse<String> r = HTTP.send(b.build(), HttpResponse.BodyHandlers.ofString());
    return new Reply(r.statusCode(), JSON.readTree(r.body()));
  }

  static Map<String, Object> evaluation(
      UUID tenant, UUID eventId, UUID txn, int score, String status) {
    Map<String, Object> m = new java.util.LinkedHashMap<>();
    m.put("tenantId", tenant.toString());
    m.put("idempotencyKey", "risk-eval:" + eventId);
    m.put("transactionEventId", eventId.toString());
    m.put("transactionId", txn.toString());
    m.put("accountId", "acc-1");
    m.put("counterpartyId", "cp-1");
    m.put("score", score);
    m.put("band", score >= 85 ? "CRITICAL" : score >= 70 ? "HIGH" : score >= 40 ? "MEDIUM" : "LOW");
    m.put(
        "factors",
        List.of(
            Map.of("name", "amount", "value", 250000.5, "contribution", 40),
            Map.of("name", "watchlist", "value", 1, "contribution", 20)));
    m.put("modelVersion", "risk-heuristic-v1.0.0");
    m.put("featureVersion", "features-v1+fx-static-v1");
    m.put(
        "watchlistHits",
        List.of(
            Map.of(
                "watchlistId", UUID.randomUUID().toString(),
                "watchlistName", "Sanctions Watch",
                "severityFloor", "HIGH",
                "entityId", UUID.randomUUID().toString(),
                "counterpartyId", "cp-1")));
    if (status != null) {
      m.put("tenantStatus", status);
    }
    return m;
  }

  <T> T inTenant(UUID tenant, Callable<T> work) {
    return Objects.requireNonNull(
        new TransactionTemplate(tx)
            .execute(s -> {
              scope.apply(tenant);
              try {
                return work.call();
              } catch (Exception e) {
                throw e instanceof RuntimeException re ? re : new IllegalStateException(e);
              }
            }));
  }

  long count(UUID tenant, String sql, Object... params) {
    return inTenant(tenant, () -> jdbc.sql(sql).params(params).query(Long.class).single());
  }

  /**
   * Recomputes every hash of the tenant's chain (the FR-AUD-03 verification, used here as an
   * oracle).
   */
  void assertChainValid(UUID tenant) {
    List<AuditRepository.Row> rows =
        inTenant(
            tenant,
            () ->
                jdbc.sql(
                        "SELECT tenant_id, seq, occurred_at, actor_type, actor_id, acting_as, action, subject_type,"
                            + " subject_id, trigger_event_id, trigger_file_id, model_version, rule_version,"
                            + " before_state::text AS b, after_state::text AS a, source_event_id, prev_hash, hash"
                            + " FROM cases.audit_log WHERE tenant_id = ? ORDER BY seq")
                    .param(tenant)
                    .query((rs, i) ->
                        new AuditRepository.Row(
                            rs.getObject("tenant_id", UUID.class),
                            rs.getLong("seq"),
                            rs.getObject("occurred_at", OffsetDateTime.class),
                            rs.getString("actor_type"),
                            rs.getString("actor_id"),
                            rs.getString("acting_as"),
                            rs.getString("action"),
                            rs.getString("subject_type"),
                            rs.getString("subject_id"),
                            rs.getObject("trigger_event_id", UUID.class),
                            rs.getObject("trigger_file_id", UUID.class),
                            rs.getString("model_version"),
                            rs.getString("rule_version"),
                            rs.getString("b"),
                            rs.getString("a"),
                            rs.getObject("source_event_id", UUID.class),
                            rs.getString("prev_hash"),
                            rs.getString("hash")))
                    .list());
    String prev = AuditHash.GENESIS;
    long seq = 1;
    for (AuditRepository.Row r : rows) {
      assertThat(r.seq()).isEqualTo(seq++);
      assertThat(r.prevHash()).isEqualTo(prev);
      assertThat(AuditHash.hash(audit.hashedFields(r), prev))
          .as("hash of seq " + r.seq())
          .isEqualTo(r.hash());
      prev = r.hash();
    }
  }

  @Test
  void scoreAtOrAbove70OpensAnEnrichingCaseWithEvidenceAuditAndEvents_FR_TXN_05_FR_CASE_01()
      throws Exception {
    UUID tenant = UUID.randomUUID();
    UUID event = UUID.randomUUID();
    UUID txn = UUID.randomUUID();
    Reply r = post("recordRiskEvaluation", SAGA, evaluation(tenant, event, txn, 82, null));
    assertThat(r.status()).isEqualTo(200);
    UUID caseId = UUID.fromString(r.data().get("caseId").asString());
    assertThat(r.data().get("suppressedReason").isNull()).isTrue();

    Map<String, Object> c =
        inTenant(
            tenant,
            () ->
                jdbc.sql(
                        "SELECT case_number, case_type, status, severity, version, policy_score, policy_version, enrichment_deadline IS NOT NULL AS d FROM cases.cases WHERE id = ?")
                    .param(caseId)
                    .query()
                    .singleRow());
    assertThat(c)
        .containsEntry("case_type", "TRANSACTION_RISK")
        .containsEntry("status", "ESCALATED") // policy ran at open: base 82 ≥ 75 (FR-CASE-04)
        .containsEntry("severity", "HIGH")
        .containsEntry("version", 3)
        .containsEntry("policy_score", 82)
        .containsEntry("policy_version", "policy-v1.0.0")
        .containsEntry("d", false);
    assertThat((String) c.get("case_number")).matches("AP-\\d{4}-000001");
    assertThat(
            inTenant(
                tenant,
                () ->
                    jdbc.sql(
                            "SELECT transition_key FROM cases.case_transitions WHERE case_id = ? ORDER BY created_at, case_version")
                        .param(caseId)
                        .query(String.class)
                        .list()))
        .containsExactly("open", "enrich:open", "policy:1", "outcome:1");
    assertThat(count(tenant, "SELECT count(*) FROM cases.case_evidence WHERE case_id = ?", caseId))
        .isEqualTo(2);
    assertThat(
            inTenant(
                tenant,
                () ->
                    jdbc.sql("SELECT action FROM cases.audit_log WHERE tenant_id = ? ORDER BY seq")
                        .param(tenant)
                        .query(String.class)
                        .list()))
        .containsExactly(
            "CASE_OPENED",
            "CASE_TRANSITION",
            "CASE_TRANSITION",
            "CASE_TRANSITION",
            "RISK_EVALUATION_RECORDED");
    assertChainValid(tenant);
    assertThat(
            inTenant(
                tenant,
                () ->
                    jdbc.sql(
                            "SELECT routing_key FROM cases.outbox_events WHERE tenant_id = ? ORDER BY event_id")
                        .param(tenant)
                        .query(String.class)
                        .list()))
        .containsExactly(
            "case.opened",
            "case.transitioned",
            "case.transitioned",
            "case.transitioned",
            "case.escalated",
            "correlation.requested",
            "risk.evaluation.recorded");
    assertThat(
            count(
                tenant,
                "SELECT count(*) FROM cases.policy_evaluations WHERE case_id = ? AND revision = 1 AND outcome = 'ESCALATED'"
                    + " AND (factors->'base_score'->>'contribution')::int = 82",
                caseId))
        .isEqualTo(1);
  }

  @Test
  void duplicatesAndRacesProduceOneEvaluationOneCaseNoExtraAuditOrEvents_FR_CASE_07()
      throws Exception {
    UUID tenant = UUID.randomUUID();
    UUID event = UUID.randomUUID();
    Map<String, Object> body = evaluation(tenant, event, UUID.randomUUID(), 90, null);
    ExecutorService pool = Executors.newFixedThreadPool(5);
    List<Future<Reply>> futures = new ArrayList<>();
    for (int i = 0; i < 5; i++) {
      futures.add(pool.submit(() -> post("recordRiskEvaluation", SAGA, body)));
    }
    List<String> ids = new ArrayList<>();
    for (Future<Reply> f : futures) {
      Reply r = f.get();
      assertThat(r.status()).as(r.body().toString()).isEqualTo(200);
      ids.add(r.data().get("id").asString());
    }
    pool.shutdown();
    Reply again = post("recordRiskEvaluation", SAGA, body);
    ids.add(again.data().get("id").asString());
    assertThat(ids).containsOnly(ids.getFirst());
    assertThat(
            count(
                tenant, "SELECT count(*) FROM cases.risk_evaluations WHERE tenant_id = ?", tenant))
        .isEqualTo(1);
    assertThat(count(tenant, "SELECT count(*) FROM cases.cases WHERE tenant_id = ?", tenant))
        .isEqualTo(1);
    assertThat(count(tenant, "SELECT count(*) FROM cases.audit_log WHERE tenant_id = ?", tenant))
        .isEqualTo(5);
    // opened, 3 × transitioned, escalated, correlation.requested, N-01 (CRITICAL),
    // risk.evaluation.recorded
    assertThat(
            count(tenant, "SELECT count(*) FROM cases.outbox_events WHERE tenant_id = ?", tenant))
        .isEqualTo(8);
    assertThat(
            count(
                tenant,
                "SELECT count(*) FROM cases.outbox_events WHERE tenant_id = ? AND routing_key = 'notification.requested'"
                    + " AND envelope->'payload'->>'templateId' = 'N-01'",
                tenant))
        .isEqualTo(1);
    assertThat(again.data().get("severity")).isNull(); // the evaluation view, not a case view
    assertChainValid(tenant);
  }

  @Test
  void belowThresholdNoCaseAndSuspendedTenantSuppressed_FR_TXN_05() throws Exception {
    UUID tenant = UUID.randomUUID();
    Reply low =
        post(
            "recordRiskEvaluation",
            SAGA,
            evaluation(tenant, UUID.randomUUID(), UUID.randomUUID(), 65, null));
    assertThat(low.data().get("caseId").isNull()).isTrue();
    Reply suspended =
        post(
            "recordRiskEvaluation",
            SAGA,
            evaluation(tenant, UUID.randomUUID(), UUID.randomUUID(), 95, "SUSPENDED"));
    assertThat(suspended.data().get("caseId").isNull()).isTrue();
    assertThat(suspended.data().get("suppressedReason").asString()).isEqualTo("TENANT_SUSPENDED");
    assertThat(count(tenant, "SELECT count(*) FROM cases.cases WHERE tenant_id = ?", tenant))
        .isZero();
    assertChainValid(tenant);
  }

  @Test
  void transitionsFollowTheTableAndDuplicateKeysAreNoOps_FR_CASE_02_FR_CASE_03() throws Exception {
    UUID tenant = UUID.randomUUID();
    Reply r =
        post(
            "recordRiskEvaluation",
            SAGA,
            evaluation(tenant, UUID.randomUUID(), UUID.randomUUID(), 75, null));
    UUID caseId = UUID.fromString(r.data().get("caseId").asString());
    assertThatThrownBy(() ->
            inTenant(
                tenant,
                () ->
                    cases.transition(
                        tenant, caseId, CaseStatus.POLICY_EVALUATED, "bad", Actor.SYSTEM, null)))
        .isInstanceOfSatisfying(
            DomainException.class, e -> assertThat(e.code()).isEqualTo("CASE_INVALID_TRANSITION"));
    var reopened =
        inTenant(
            tenant,
            () ->
                cases.transition(
                    tenant, caseId, CaseStatus.ENRICHING, "reeval:1", Actor.SYSTEM, null));
    var again =
        inTenant(
            tenant,
            () ->
                cases.transition(
                    tenant, caseId, CaseStatus.ENRICHING, "reeval:1", Actor.SYSTEM, null));
    assertThat(again.version()).isEqualTo(reopened.version()).isEqualTo(4);
    assertThat(count(tenant, "SELECT count(*) FROM cases.audit_log WHERE tenant_id = ?", tenant))
        .isEqualTo(6);
    assertChainValid(tenant);
  }

  @Test
  void policyClearsBelow75WithoutCorrelationAndSweepsEvaluateTimeoutsAndAutoResolve_FR_CASE_02_04()
      throws Exception {
    UUID tenant = UUID.randomUUID();
    Reply cleared =
        post(
            "recordRiskEvaluation",
            SAGA,
            evaluation(tenant, UUID.randomUUID(), UUID.randomUUID(), 72, null));
    UUID clearedId = UUID.fromString(cleared.data().get("caseId").asString());
    Map<String, Object> c =
        inTenant(
            tenant,
            () ->
                jdbc.sql("SELECT status, severity, policy_score FROM cases.cases WHERE id = ?")
                    .param(clearedId)
                    .query()
                    .singleRow());
    assertThat(c)
        .containsEntry("status", "CLEARED")
        .containsEntry("severity", "HIGH")
        .containsEntry("policy_score", 72);
    assertThat(
            count(
                tenant,
                "SELECT count(*) FROM cases.outbox_events WHERE tenant_id = ? AND routing_key = 'correlation.requested'",
                tenant))
        .isZero();

    // A case opened without its enrichment stays ENRICHING until the 10-min deadline; the sweep
    // evaluates it.
    Reply opened =
        post(
            "openCase",
            SAGA,
            Map.of(
                "tenantId",
                tenant.toString(),
                "caseType",
                "DOCUMENT_RISK",
                "severity",
                "HIGH",
                "triggerEventId",
                UUID.randomUUID().toString(),
                "openIdempotencyKey",
                "doc-risk:" + UUID.randomUUID()));
    assertThat(opened.status()).as(opened.body().toString()).isEqualTo(200);
    UUID docCase = UUID.fromString(opened.data().get("id").asString());
    assertThat(opened.data().get("status").asString()).isEqualTo("ENRICHING");
    String scheduler =
        Tokens.service(
            "svc-scheduler-trigger", "cases.runEnrichmentTimeouts", "cases.autoResolveCleared");
    assertThat(
            post("runEnrichmentTimeouts", scheduler, Map.of()).data().get("processedCount").asInt())
        .isGreaterThanOrEqualTo(0);
    assertThat(
            inTenant(
                tenant,
                () ->
                    jdbc.sql("SELECT status FROM cases.cases WHERE id = ?")
                        .param(docCase)
                        .query(String.class)
                        .single()))
        .isEqualTo("ENRICHING"); // deadline not reached
    inTenant(
        tenant,
        () ->
            jdbc.sql(
                    "UPDATE cases.cases SET enrichment_deadline = now() - interval '1 minute' WHERE id = ?")
                .param(docCase)
                .update());
    Reply swept = post("runEnrichmentTimeouts", scheduler, Map.of());
    assertThat(swept.data().get("processedCount").asInt()).isGreaterThanOrEqualTo(1);
    Map<String, Object> d =
        inTenant(
            tenant,
            () ->
                jdbc.sql("SELECT status, severity, policy_score FROM cases.cases WHERE id = ?")
                    .param(docCase)
                    .query()
                    .singleRow());
    assertThat(d)
        .containsEntry("status", "CLEARED")
        .containsEntry("severity", "MEDIUM")
        .containsEntry("policy_score", 50);
    assertThat(
            inTenant(
                tenant,
                () ->
                    jdbc.sql(
                            "SELECT trigger_type FROM cases.case_transitions WHERE case_id = ? AND transition_key = 'policy:1'")
                        .param(docCase)
                        .query(String.class)
                        .single()))
        .isEqualTo("TIMER");

    // Auto-resolve: CLEARED for 7 days with no new evidence (backdated as the superuser, bypassing
    // the updated_at trigger).
    try (Connection admin =
        DriverManager.getConnection(
            Infra.POSTGRES.getJdbcUrl(),
            Infra.POSTGRES.getUsername(),
            Infra.POSTGRES.getPassword())) {
      admin
          .createStatement()
          .execute("ALTER TABLE cases.cases DISABLE TRIGGER trg_cases_updated_at");
      admin
          .createStatement()
          .executeUpdate(
              "UPDATE cases.cases SET updated_at = now() - interval '8 days' WHERE id = '"
                  + docCase
                  + "'");
      admin
          .createStatement()
          .execute("ALTER TABLE cases.cases ENABLE TRIGGER trg_cases_updated_at");
    }
    assertThat(post("autoResolveCleared", scheduler, Map.of()).data().get("processedCount").asInt())
        .isGreaterThanOrEqualTo(1);
    assertThat(
            inTenant(
                tenant,
                () ->
                    jdbc.sql("SELECT status FROM cases.cases WHERE id = ?")
                        .param(docCase)
                        .query(String.class)
                        .single()))
        .isEqualTo("RESOLVED");
    assertThat(
            inTenant(
                tenant,
                () ->
                    jdbc.sql("SELECT status FROM cases.cases WHERE id = ?")
                        .param(clearedId)
                        .query(String.class)
                        .single()))
        .isEqualTo("CLEARED"); // recent: untouched
    assertThat(post("runEnrichmentTimeouts", SAGA, Map.of()).status()).isEqualTo(403);
    assertChainValid(tenant);
  }

  @Test
  void getTransactionEvaluationIsTenantScopedAndRoleChecked_FR_TXN_06() throws Exception {
    UUID tenant = UUID.randomUUID();
    UUID txn = UUID.randomUUID();
    post("recordRiskEvaluation", SAGA, evaluation(tenant, UUID.randomUUID(), txn, 40, null));
    Map<String, String> q = Map.of("transactionId", txn.toString());
    String viewer = Tokens.user(UUID.randomUUID(), tenant, "t", "VIEWER");
    Reply own = post("getTransactionEvaluation", viewer, q);
    assertThat(own.status()).isEqualTo(200);
    assertThat(own.data().get("score").asInt()).isEqualTo(40);
    Reply other =
        post(
            "getTransactionEvaluation",
            Tokens.user(UUID.randomUUID(), UUID.randomUUID(), "o", "ANALYST"),
            q);
    assertThat(other.status()).isEqualTo(404);
    Reply auditor =
        post(
            "getTransactionEvaluation",
            Tokens.user(UUID.randomUUID(), tenant, "t", "COMPLIANCE_AUDITOR"),
            q);
    assertThat(auditor.status()).isEqualTo(403);
    Reply pa =
        post(
            "getTransactionEvaluation",
            Tokens.user(UUID.randomUUID(), UUID.randomUUID(), "platform", "PLATFORM_ADMIN"),
            q,
            tenant.toString());
    assertThat(pa.status()).isEqualTo(200);
    Reply saga = post("getTransactionEvaluation", SAGA, q);
    assertThat(saga.status()).isEqualTo(403);
    Reply userRecords =
        post("recordRiskEvaluation", viewer, evaluation(tenant, UUID.randomUUID(), txn, 99, null));
    assertThat(userRecords.status()).isEqualTo(403);
  }

  @Test
  void auditLogRejectsUpdateDeleteForTheRoleAndTheTrigger_FR_AUD_01() throws Exception {
    UUID tenant = UUID.randomUUID();
    post(
        "recordRiskEvaluation",
        SAGA,
        evaluation(tenant, UUID.randomUUID(), UUID.randomUUID(), 10, null));
    assertThatThrownBy(() ->
            inTenant(
                tenant,
                () ->
                    jdbc.sql("UPDATE cases.audit_log SET action = 'X' WHERE tenant_id = ?")
                        .param(tenant)
                        .update()))
        .rootCause()
        .hasMessageContaining("permission denied");
    assertThatThrownBy(() ->
            inTenant(
                tenant,
                () ->
                    jdbc.sql("DELETE FROM cases.audit_log WHERE tenant_id = ?")
                        .param(tenant)
                        .update()))
        .rootCause()
        .hasMessageContaining("permission denied");
    // Even the superuser hits the append-only trigger.
    try (Connection admin =
        DriverManager.getConnection(
            Infra.POSTGRES.getJdbcUrl(),
            Infra.POSTGRES.getUsername(),
            Infra.POSTGRES.getPassword())) {
      assertThatThrownBy(() ->
              admin.createStatement().executeUpdate("UPDATE cases.audit_log SET action = 'X'"))
          .isInstanceOf(SQLException.class)
          .hasMessageContaining("append-only");
      assertThatThrownBy(() -> admin.createStatement().executeUpdate("TRUNCATE cases.audit_log"))
          .hasMessageContaining("append-only");
    }
  }

  // ── FR-AUD-02/03: ingest, list, verify ───────────────────────────────────────────────────────

  static String envelope(UUID eventId, String eventType, UUID tenant, Map<String, Object> payload) {
    Map<String, Object> e = new java.util.LinkedHashMap<>();
    e.put("eventId", eventId.toString());
    e.put("correlationId", "corr-" + UUID.randomUUID());
    e.put("causationId", null);
    e.put("tenantId", tenant == null ? null : tenant.toString());
    e.put("schemaVersion", "1.0.0");
    e.put("eventType", eventType);
    e.put("source", "service:registry");
    e.put("producer", "aegispulse-registry@abc1234");
    e.put("occurredAt", java.time.Instant.now().toString());
    e.put("ingestedAt", java.time.Instant.now().toString());
    e.put("idempotencyKey", eventType + ":" + eventId);
    e.put("classification", Map.of("sensitivity", "INTERNAL", "status", "INGESTED"));
    e.put("payload", payload);
    return JSON.writeValueAsString(e);
  }

  static void publish(String exchange, String routingKey, String body) throws Exception {
    try (com.rabbitmq.client.Connection c = Infra.adminConnection();
        com.rabbitmq.client.Channel ch = c.createChannel()) {
      ch.confirmSelect();
      ch.basicPublish(
          exchange,
          routingKey,
          new com.rabbitmq.client.AMQP.BasicProperties.Builder()
              .contentType("application/json")
              .deliveryMode(2)
              .build(),
          body.getBytes(StandardCharsets.UTF_8));
      ch.waitForConfirmsOrDie(5_000);
    }
  }

  void await(java.util.function.BooleanSupplier condition) throws InterruptedException {
    long deadline = System.nanoTime() + java.time.Duration.ofSeconds(15).toNanos();
    while (!condition.getAsBoolean()) {
      if (System.nanoTime() > deadline) {
        throw new AssertionError("condition not met within 15 s");
      }
      Thread.sleep(50);
    }
  }

  @Test
  void auditIngestChainsOtherServicesEventsOnceEachIncludingPlatformEvents_FR_AUD_02()
      throws Exception {
    UUID tenant = UUID.randomUUID();
    UUID userChanged = UUID.randomUUID();
    String body =
        envelope(
            userChanged,
            "registry.user.changed",
            tenant,
            Map.of("userId", UUID.randomUUID().toString(), "changedFields", List.of("roles")));
    publish("aegispulse.domain", "registry.user.changed", body);
    publish("aegispulse.domain", "registry.user.changed", body); // redelivery of the same event
    UUID actor = UUID.randomUUID();
    publish(
        "aegispulse.intelligence",
        "ops.audit.file_deleted",
        envelope(
            UUID.randomUUID(),
            "ops.audit.file_deleted",
            tenant,
            Map.of("fileId", UUID.randomUUID().toString(), "actorId", actor.toString())));
    await(() ->
        count(tenant, "SELECT count(*) FROM cases.audit_log WHERE tenant_id = ?", tenant) == 2);
    Thread.sleep(500); // the duplicate has had time to arrive
    List<Map<String, Object>> rows =
        inTenant(
            tenant,
            () ->
                jdbc.sql(
                        "SELECT action, actor_type, actor_id, subject_type, source_event_id FROM cases.audit_log WHERE tenant_id = ? ORDER BY seq")
                    .param(tenant)
                    .query()
                    .listOfRows());
    assertThat(rows).hasSize(2);
    assertThat(rows.get(0))
        .containsEntry("action", "REGISTRY_USER_CHANGED")
        .containsEntry("actor_type", "SERVICE")
        .containsEntry("actor_id", "aegispulse-registry")
        .containsEntry("subject_type", "USER");
    assertThat(rows.get(1))
        .containsEntry("action", "OPS_AUDIT_FILE_DELETED")
        .containsEntry("actor_type", "USER")
        .containsEntry("actor_id", actor.toString());
    assertChainValid(tenant);

    UUID platform = UUID.fromString("00000000-0000-0000-0000-000000000001");
    UUID platformEvent = UUID.randomUUID();
    publish(
        "aegispulse.intelligence",
        "ops.audit.dead_letter_resolved",
        envelope(
            platformEvent,
            "ops.audit.dead_letter_resolved",
            null,
            Map.of(
                "deadLetterId",
                "abc",
                "queue",
                "q",
                "action",
                "DISCARDED",
                "actorId",
                actor.toString())));
    await(() ->
        count(
                platform,
                "SELECT count(*) FROM cases.audit_log WHERE tenant_id = ? AND source_event_id = ?",
                platform,
                platformEvent)
            == 1);
  }

  @Test
  void listAndVerifyOverHttpDetectTamperingAndTheNightlyJobRaisesN06_FR_AUD_03() throws Exception {
    UUID tenant = UUID.randomUUID();
    for (int i = 0; i < 3; i++) {
      post(
          "recordRiskEvaluation",
          SAGA,
          evaluation(tenant, UUID.randomUUID(), UUID.randomUUID(), 10 + i, null));
    }
    String auditor = Tokens.user(UUID.randomUUID(), tenant, "t", "COMPLIANCE_AUDITOR");
    Reply all = post("listAuditEntries", auditor, Map.of("limit", 2));
    assertThat(all.status()).isEqualTo(200);
    assertThat(all.data()).hasSize(2);
    assertThat(all.data().get(0).get("seq").asLong()).isEqualTo(3);
    String cursor = all.body().path("meta").path("nextCursor").asString();
    Reply next = post("listAuditEntries", auditor, Map.of("limit", 2, "cursor", cursor));
    assertThat(next.data()).hasSize(1);
    assertThat(next.data().get(0).get("seq").asLong()).isEqualTo(1);
    Reply filtered =
        post(
            "listAuditEntries",
            Tokens.user(UUID.randomUUID(), tenant, "t", "TENANT_ADMIN"),
            Map.of("action", "RISK_EVALUATION_RECORDED"));
    assertThat(filtered.data()).hasSize(3);
    assertThat(
            post(
                    "listAuditEntries",
                    Tokens.user(UUID.randomUUID(), tenant, "t", "ANALYST"),
                    Map.of())
                .status())
        .isEqualTo(403);
    assertThat(
            post(
                    "verifyAuditChain",
                    Tokens.user(UUID.randomUUID(), tenant, "t", "TENANT_ADMIN"),
                    Map.of())
                .status())
        .isEqualTo(403);

    Reply valid = post("verifyAuditChain", auditor, Map.of());
    assertThat(valid.data().get("valid").asBoolean()).isTrue();
    assertThat(valid.data().get("checked").asLong()).isEqualTo(3);

    // Tamper with seq 2 the only way possible: as the superuser, with the append-only trigger
    // disabled.
    try (Connection admin =
        DriverManager.getConnection(
            Infra.POSTGRES.getJdbcUrl(),
            Infra.POSTGRES.getUsername(),
            Infra.POSTGRES.getPassword())) {
      admin
          .createStatement()
          .execute("ALTER TABLE cases.audit_log DISABLE TRIGGER trg_audit_no_update");
      admin
          .createStatement()
          .executeUpdate(
              "UPDATE cases.audit_log SET after_state = jsonb_set(after_state, '{score}', '99') WHERE tenant_id = '"
                  + tenant
                  + "' AND seq = 2");
      admin
          .createStatement()
          .execute("ALTER TABLE cases.audit_log ENABLE TRIGGER trg_audit_no_update");
    }
    Reply broken = post("verifyAuditChain", auditor, Map.of());
    assertThat(broken.status()).isEqualTo(200);
    assertThat(broken.data().get("valid").asBoolean()).isFalse();
    assertThat(broken.data().get("firstBrokenSeq").asLong()).isEqualTo(2);
    assertThat(broken.data().get("code").asString()).isEqualTo("AUDIT_CHAIN_BROKEN");
    assertThat(
            post("verifyAuditChain", auditor, Map.of("fromSeq", 3)).data().get("valid").asBoolean())
        .isTrue();

    // Nightly job (SERVICE, no tenantId): every pending chain; the broken one raises N-06 and stays
    // unverified.
    String job = Tokens.service("svc-scheduler-trigger", "cases.verifyAuditChain");
    Reply nightly = post("verifyAuditChain", job, Map.of());
    assertThat(nightly.status()).as(nightly.body().toString()).isEqualTo(200);
    assertThat(nightly.data().get("valid").asBoolean()).isFalse();
    assertThat(
            count(
                tenant,
                "SELECT count(*) FROM cases.outbox_events WHERE tenant_id = ? AND routing_key = 'notification.requested' AND envelope->'payload'->>'templateId' = 'N-06'",
                tenant))
        .isEqualTo(1);
    assertThat(
            count(
                tenant,
                "SELECT verified_seq FROM cases.audit_chain_heads WHERE tenant_id = ?",
                tenant))
        .isZero();
    UUID healthy = UUID.randomUUID();
    post(
        "recordRiskEvaluation",
        SAGA,
        evaluation(healthy, UUID.randomUUID(), UUID.randomUUID(), 5, null));
    post("verifyAuditChain", job, Map.of());
    assertThat(
            count(
                healthy,
                "SELECT verified_seq FROM cases.audit_chain_heads WHERE tenant_id = ?",
                healthy))
        .isEqualTo(1);
  }
}
