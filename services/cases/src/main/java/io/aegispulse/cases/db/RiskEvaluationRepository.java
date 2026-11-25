package io.aegispulse.cases.db;

import io.aegispulse.cases.domain.RiskEvaluation;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/** cases.risk_evaluations under tenant RLS (FR-TXN-05/06). */
@Repository
public class RiskEvaluationRepository {
  private static final TypeReference<List<Map<String, @Nullable Object>>> LIST =
      new TypeReference<>() {};
  private static final String COLUMNS =
      "id, tenant_id, idempotency_key, transaction_event_id, transaction_id, account_id, counterparty_id,"
          + " score, band, factors::text AS factors, model_version, feature_version,"
          + " watchlist_hits::text AS watchlist_hits, case_id, suppressed_reason, created_at";

  private final JdbcClient jdbc;
  private final JsonMapper json;

  public RiskEvaluationRepository(JdbcClient jdbc, JsonMapper json) {
    this.jdbc = jdbc;
    this.json = json;
  }

  /** Inserts unless (tenant, idempotency key) exists; empty when it does. */
  public Optional<RiskEvaluation> insert(RiskEvaluation e) {
    return jdbc.sql(
            "INSERT INTO cases.risk_evaluations (id, tenant_id, idempotency_key, transaction_event_id,"
                + " transaction_id, account_id, counterparty_id, score, band, factors, model_version,"
                + " feature_version, watchlist_hits, case_id, suppressed_reason)"
                + " VALUES (?,?,?,?,?,?,?,?,?,?::jsonb,?,?,?::jsonb,?,?)"
                + " ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING "
                + COLUMNS)
        .params(
            Arrays.asList(
                e.id(),
                e.tenantId(),
                e.idempotencyKey(),
                e.transactionEventId(),
                e.transactionId(),
                e.accountId(),
                e.counterpartyId(),
                e.score(),
                e.band(),
                json.writeValueAsString(e.factors()),
                e.modelVersion(),
                e.featureVersion(),
                json.writeValueAsString(e.watchlistHits()),
                e.caseId(),
                e.suppressedReason()))
        .query(this::map)
        .optional();
  }

  public Optional<RiskEvaluation> findByKey(UUID tenantId, String key) {
    return jdbc.sql(
            "SELECT "
                + COLUMNS
                + " FROM cases.risk_evaluations WHERE tenant_id = ? AND idempotency_key = ?")
        .params(tenantId, key)
        .query(this::map)
        .optional();
  }

  /** The latest evaluation of a transaction (FR-TXN-06). */
  public Optional<RiskEvaluation> findLatestByTransaction(UUID tenantId, UUID transactionId) {
    return jdbc.sql(
            "SELECT "
                + COLUMNS
                + " FROM cases.risk_evaluations WHERE tenant_id = ? AND transaction_id = ?"
                + " ORDER BY created_at DESC, id DESC LIMIT 1")
        .params(tenantId, transactionId)
        .query(this::map)
        .optional();
  }

  private RiskEvaluation map(ResultSet rs, int row) throws SQLException {
    return new RiskEvaluation(
        rs.getObject("id", UUID.class),
        rs.getObject("tenant_id", UUID.class),
        rs.getString("idempotency_key"),
        rs.getObject("transaction_event_id", UUID.class),
        rs.getObject("transaction_id", UUID.class),
        rs.getString("account_id"),
        rs.getString("counterparty_id"),
        rs.getInt("score"),
        rs.getString("band"),
        json.readValue(rs.getString("factors"), LIST),
        rs.getString("model_version"),
        rs.getString("feature_version"),
        json.readValue(rs.getString("watchlist_hits"), LIST),
        rs.getObject("case_id", UUID.class),
        rs.getString("suppressed_reason"),
        rs.getObject("created_at", OffsetDateTime.class));
  }
}
