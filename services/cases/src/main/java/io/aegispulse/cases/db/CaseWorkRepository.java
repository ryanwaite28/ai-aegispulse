package io.aegispulse.cases.db;

import io.aegispulse.cases.domain.CaseWork;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
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

/**
 * Case work reads/writes under tenant RLS (FR-CASE-05/06/08): lists, history, notes, dispositions.
 */
@Repository
public class CaseWorkRepository {
  private static final TypeReference<Map<String, @Nullable Object>> MAP = new TypeReference<>() {};

  private final JdbcClient jdbc;
  private final JsonMapper json;

  public CaseWorkRepository(JdbcClient jdbc, JsonMapper json) {
    this.jdbc = jdbc;
    this.json = json;
  }

  /** Case ids newest first (created_at DESC, id DESC keyset). */
  public List<UUID> listIds(
      UUID tenantId,
      CaseWork.Filter f,
      @Nullable OffsetDateTime beforeAt,
      @Nullable UUID beforeId,
      int limit) {
    StringBuilder sql = new StringBuilder("SELECT id FROM cases.cases WHERE tenant_id = ?");
    List<@Nullable Object> p = new ArrayList<>(List.of(tenantId));
    if (f.status() != null) {
      sql.append(" AND status = ?");
      p.add(f.status());
    }
    if (f.caseType() != null) {
      sql.append(" AND case_type = ?");
      p.add(f.caseType());
    }
    if (f.severity() != null) {
      sql.append(" AND severity = ?");
      p.add(f.severity());
    }
    if (f.assigneeUserId() != null) {
      sql.append(" AND assignee_user_id = ?");
      p.add(f.assigneeUserId());
    }
    if (f.entityId() != null) {
      sql.append(" AND primary_entity_ids @> ARRAY[?]::uuid[]");
      p.add(f.entityId());
    }
    if (beforeAt != null && beforeId != null) {
      sql.append(" AND (created_at, id) < (?, ?)");
      p.add(beforeAt);
      p.add(beforeId);
    }
    sql.append(" ORDER BY created_at DESC, id DESC LIMIT ?");
    p.add(limit);
    return jdbc.sql(sql.toString()).params(p).query(UUID.class).list().stream()
        .map(java.util.Objects::requireNonNull)
        .toList();
  }

  /** Optimistic assignment (FR-CASE-05/07): applies only at expectedVersion; empty when stale. */
  public boolean assign(UUID tenantId, UUID caseId, int expectedVersion, @Nullable UUID assignee) {
    return jdbc.sql(
                "UPDATE cases.cases SET assignee_user_id = ?, version = version + 1"
                    + " WHERE tenant_id = ? AND id = ? AND version = ?")
            .params(Arrays.asList(assignee, tenantId, caseId, expectedVersion))
            .update()
        == 1;
  }

  /** Sets or clears the four-eyes pending disposition (FR-CASE-06) at expectedVersion. */
  public boolean setPending(
      UUID tenantId,
      UUID caseId,
      int expectedVersion,
      @Nullable String pending,
      @Nullable UUID reviewer) {
    return jdbc.sql(
                "UPDATE cases.cases SET pending_disposition = ?, pending_reviewer_id = ?, version = version + 1"
                    + " WHERE tenant_id = ? AND id = ? AND version = ?")
            .params(Arrays.asList(pending, reviewer, tenantId, caseId, expectedVersion))
            .update()
        == 1;
  }

  public CaseWork.Note insertNote(UUID tenantId, UUID caseId, UUID authorId, String body) {
    return jdbc.sql(
            "INSERT INTO cases.case_notes (tenant_id, case_id, author_id, body, locked_at)"
                + " VALUES (?,?,?,?, now() + interval '15 minutes')"
                + " RETURNING id, case_id, author_id, body, locked_at, created_at")
        .params(tenantId, caseId, authorId, body)
        .query(this::note)
        .single();
  }

  public Optional<CaseWork.Disposition> findDisposition(UUID tenantId, String idempotencyKey) {
    return jdbc.sql(
            "SELECT id, case_id, disposition, rationale, analyst_id, model_versions, rule_versions, policy_version, created_at"
                + " FROM cases.case_dispositions WHERE tenant_id = ? AND idempotency_key = ?")
        .params(tenantId, idempotencyKey)
        .query(this::disposition)
        .optional();
  }

  public CaseWork.Disposition insertDisposition(
      UUID tenantId,
      UUID caseId,
      String disposition,
      String rationale,
      UUID analystId,
      List<String> modelVersions,
      List<String> ruleVersions,
      @Nullable String policyVersion,
      String idempotencyKey) {
    return jdbc.sql(
            "INSERT INTO cases.case_dispositions (tenant_id, case_id, disposition, rationale, analyst_id, model_versions,"
                + " rule_versions, policy_version, idempotency_key) VALUES (?,?,?,?,?,?::text[],?::text[],?,?)"
                + " RETURNING id, case_id, disposition, rationale, analyst_id, model_versions, rule_versions, policy_version,"
                + " created_at")
        .params(
            Arrays.asList(
                tenantId,
                caseId,
                disposition,
                rationale,
                analystId,
                textArray(modelVersions),
                textArray(ruleVersions),
                policyVersion,
                idempotencyKey))
        .query(this::disposition)
        .single();
  }

  /**
   * Model versions of the case's risk evaluations and policy versions of its policy evaluations.
   */
  public List<String> modelVersions(UUID caseId) {
    return jdbc
        .sql(
            "SELECT DISTINCT model_version FROM cases.risk_evaluations WHERE case_id = ? ORDER BY 1")
        .param(caseId)
        .query(String.class)
        .list()
        .stream()
        .map(java.util.Objects::requireNonNull)
        .toList();
  }

  public List<String> ruleVersions(UUID caseId) {
    return jdbc
        .sql(
            "SELECT DISTINCT policy_version FROM cases.policy_evaluations WHERE case_id = ? ORDER BY 1")
        .param(caseId)
        .query(String.class)
        .list()
        .stream()
        .map(java.util.Objects::requireNonNull)
        .toList();
  }

  public Optional<CaseWork.PolicyEvaluation> latestPolicy(UUID caseId) {
    return jdbc.sql(
            "SELECT id, revision, policy_version, policy_score, outcome, factors::text AS factors, created_at"
                + " FROM cases.policy_evaluations WHERE case_id = ? ORDER BY revision DESC LIMIT 1")
        .param(caseId)
        .query((rs, i) ->
            new CaseWork.PolicyEvaluation(
                rs.getObject("id", UUID.class),
                rs.getInt("revision"),
                rs.getString("policy_version"),
                rs.getInt("policy_score"),
                rs.getString("outcome"),
                json.readValue(rs.getString("factors"), MAP),
                rs.getObject("created_at", OffsetDateTime.class)))
        .optional();
  }

  public CaseWork.Timeline timeline(UUID caseId) {
    List<CaseWork.Transition> transitions =
        jdbc.sql(
                "SELECT id, from_status, to_status, trigger_type, trigger_ref, case_version, created_at"
                    + " FROM cases.case_transitions WHERE case_id = ? ORDER BY case_version, created_at")
            .param(caseId)
            .query((rs, i) ->
                new CaseWork.Transition(
                    rs.getObject("id", UUID.class),
                    rs.getString("from_status"),
                    rs.getString("to_status"),
                    rs.getString("trigger_type"),
                    rs.getString("trigger_ref"),
                    rs.getInt("case_version"),
                    rs.getObject("created_at", OffsetDateTime.class)))
            .list();
    List<CaseWork.Evidence> evidence =
        jdbc.sql(
                "SELECT id, evidence_type, evidence_ref, final_severity, summary::text AS summary, attached_by, created_at"
                    + " FROM cases.case_evidence WHERE case_id = ? ORDER BY created_at, id")
            .param(caseId)
            .query((rs, i) ->
                new CaseWork.Evidence(
                    rs.getObject("id", UUID.class),
                    rs.getString("evidence_type"),
                    rs.getString("evidence_ref"),
                    rs.getString("final_severity"),
                    json.readValue(rs.getString("summary"), MAP),
                    rs.getString("attached_by"),
                    rs.getObject("created_at", OffsetDateTime.class)))
            .list();
    List<CaseWork.Note> notes =
        jdbc.sql(
                "SELECT id, case_id, author_id, body, locked_at, created_at FROM cases.case_notes WHERE case_id = ?"
                    + " ORDER BY created_at, id")
            .param(caseId)
            .query(this::note)
            .list();
    List<CaseWork.Disposition> dispositions =
        jdbc.sql(
                "SELECT id, case_id, disposition, rationale, analyst_id, model_versions, rule_versions, policy_version,"
                    + " created_at FROM cases.case_dispositions WHERE case_id = ? ORDER BY created_at, id")
            .param(caseId)
            .query(this::disposition)
            .list();
    return new CaseWork.Timeline(caseId, transitions, evidence, notes, dispositions);
  }

  private CaseWork.Note note(ResultSet rs, int i) throws SQLException {
    return new CaseWork.Note(
        rs.getObject("id", UUID.class),
        rs.getObject("case_id", UUID.class),
        rs.getObject("author_id", UUID.class),
        rs.getString("body"),
        rs.getObject("locked_at", OffsetDateTime.class),
        rs.getObject("created_at", OffsetDateTime.class));
  }

  private CaseWork.Disposition disposition(ResultSet rs, int i) throws SQLException {
    return new CaseWork.Disposition(
        rs.getObject("id", UUID.class),
        rs.getObject("case_id", UUID.class),
        rs.getString("disposition"),
        rs.getString("rationale"),
        rs.getObject("analyst_id", UUID.class),
        strings(rs.getArray("model_versions")),
        strings(rs.getArray("rule_versions")),
        rs.getString("policy_version"),
        rs.getObject("created_at", OffsetDateTime.class));
  }

  private static List<String> strings(@Nullable Array a) throws SQLException {
    return a == null
        ? List.of()
        : Arrays.stream((Object[]) a.getArray()).map(String::valueOf).toList();
  }

  private static String textArray(List<String> values) {
    StringBuilder b = new StringBuilder("{");
    for (int i = 0; i < values.size(); i++) {
      if (i > 0) {
        b.append(',');
      }
      b.append('"').append(values.get(i).replace("\\", "\\\\").replace("\"", "\\\"")).append('"');
    }
    return b.append('}').toString();
  }
}
