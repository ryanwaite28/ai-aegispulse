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
                        "SELECT case_number, case_type, status, severity, version, enrichment_deadline IS NOT NULL AS d FROM cases.cases WHERE id = ?")
                    .param(caseId)
                    .query()
                    .singleRow());
    assertThat(c)
        .containsEntry("case_type", "TRANSACTION_RISK")
        .containsEntry("status", "ENRICHING")
        .containsEntry("severity", "HIGH")
        .containsEntry("version", 1)
        .containsEntry("d", true);
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
        .containsExactly("open", "enrich:open");
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
        .containsExactly("CASE_OPENED", "CASE_TRANSITION", "RISK_EVALUATION_RECORDED");
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
        .containsExactly("case.opened", "case.transitioned", "risk.evaluation.recorded");
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
        .isEqualTo(3);
    assertThat(
            count(tenant, "SELECT count(*) FROM cases.outbox_events WHERE tenant_id = ?", tenant))
        .isEqualTo(3);
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
                        tenant, caseId, CaseStatus.RESOLVED, "bad", Actor.SYSTEM, null)))
        .isInstanceOfSatisfying(
            DomainException.class, e -> assertThat(e.code()).isEqualTo("CASE_INVALID_TRANSITION"));
    var evaluated =
        inTenant(
            tenant,
            () ->
                cases.transition(
                    tenant, caseId, CaseStatus.POLICY_EVALUATED, "policy:1", Actor.SYSTEM, null));
    var again =
        inTenant(
            tenant,
            () ->
                cases.transition(
                    tenant, caseId, CaseStatus.POLICY_EVALUATED, "policy:1", Actor.SYSTEM, null));
    assertThat(again.version()).isEqualTo(evaluated.version()).isEqualTo(2);
    assertThat(count(tenant, "SELECT count(*) FROM cases.audit_log WHERE tenant_id = ?", tenant))
        .isEqualTo(4);
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
}
