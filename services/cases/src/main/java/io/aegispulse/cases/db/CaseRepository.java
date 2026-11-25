package io.aegispulse.cases.db;

import io.aegispulse.cases.domain.CaseRecord;
import io.aegispulse.cases.domain.CaseStatus;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** cases.cases, case_number_sequences, case_transitions, case_evidence under tenant RLS. */
@Repository
public class CaseRepository {
  private static final String COLUMNS =
      "id, tenant_id, case_number, case_type, status, severity, policy_score, policy_version,"
          + " primary_entity_ids, trigger_event_id, trigger_file_id, open_idempotency_key, previous_case_id,"
          + " assignee_user_id, pending_disposition, enrichment_deadline, resolved_at, version, created_at,"
          + " updated_at";

  private final JdbcClient jdbc;

  public CaseRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public record NewCase(
      UUID id,
      UUID tenantId,
      String caseNumber,
      String caseType,
      String severity,
      List<UUID> primaryEntityIds,
      UUID triggerEventId,
      @Nullable UUID triggerFileId,
      String openIdempotencyKey,
      @Nullable UUID previousCaseId) {}

  /** Next value of the tenant's yearly sequence (row lock until commit keeps numbers gapless). */
  public int nextCaseSequence(UUID tenantId, int year) {
    return jdbc.sql(
            "INSERT INTO cases.case_number_sequences (tenant_id, year, next_value) VALUES (?, ?, 2)"
                + " ON CONFLICT (tenant_id, year) DO UPDATE SET next_value = cases.case_number_sequences.next_value + 1"
                + " RETURNING next_value - 1")
        .params(tenantId, year)
        .query(Integer.class)
        .single();
  }

  /** Inserts the case as OPEN unless (tenant, open key) exists; empty when it does. */
  public Optional<CaseRecord> insertOpen(NewCase c) {
    return jdbc.sql(
            "INSERT INTO cases.cases (id, tenant_id, case_number, case_type, status, severity,"
                + " primary_entity_ids, trigger_event_id, trigger_file_id, open_idempotency_key, previous_case_id)"
                + " VALUES (?,?,?,?,'OPEN',?,?::uuid[],?,?,?,?)"
                + " ON CONFLICT (tenant_id, open_idempotency_key) DO NOTHING RETURNING "
                + COLUMNS)
        .params(
            Arrays.asList(
                c.id(),
                c.tenantId(),
                c.caseNumber(),
                c.caseType(),
                c.severity(),
                uuidArray(c.primaryEntityIds()),
                c.triggerEventId(),
                c.triggerFileId(),
                c.openIdempotencyKey(),
                c.previousCaseId()))
        .query(this::map)
        .optional();
  }

  public Optional<CaseRecord> findByOpenKey(UUID tenantId, String key) {
    return jdbc.sql(
            "SELECT "
                + COLUMNS
                + " FROM cases.cases WHERE tenant_id = ? AND open_idempotency_key = ?")
        .params(tenantId, key)
        .query(this::map)
        .optional();
  }

  public Optional<CaseRecord> findById(UUID tenantId, UUID id) {
    return jdbc.sql("SELECT " + COLUMNS + " FROM cases.cases WHERE tenant_id = ? AND id = ?")
        .params(tenantId, id)
        .query(this::map)
        .optional();
  }

  /**
   * Optimistic-locking status change (FR-CASE-03/07): applies only at {@code expectedVersion} and
   * bumps it; empty when another writer won.
   */
  public Optional<CaseRecord> updateStatus(
      UUID tenantId,
      UUID id,
      int expectedVersion,
      CaseStatus to,
      @Nullable OffsetDateTime enrichmentDeadline) {
    return updateStatus(tenantId, id, expectedVersion, to, enrichmentDeadline, null);
  }

  /**
   * Policy result written with the status change (FR-CASE-04): score, version and severity =
   * band(score).
   */
  public record PolicyResult(int score, String version, String severity) {}

  public Optional<CaseRecord> updateStatus(
      UUID tenantId,
      UUID id,
      int expectedVersion,
      CaseStatus to,
      @Nullable OffsetDateTime enrichmentDeadline,
      @Nullable PolicyResult policy) {
    return jdbc.sql(
            "UPDATE cases.cases SET status = ?, version = version + 1, enrichment_deadline = ?,"
                + " resolved_at = CASE WHEN ? = 'RESOLVED' THEN now() ELSE resolved_at END,"
                + " policy_score = COALESCE(?, policy_score), policy_version = COALESCE(?, policy_version),"
                + " severity = COALESCE(?, severity)"
                + " WHERE tenant_id = ? AND id = ? AND version = ? RETURNING "
                + COLUMNS)
        .params(
            Arrays.asList(
                to.name(),
                enrichmentDeadline,
                to.name(),
                policy == null ? null : policy.score(),
                policy == null ? null : policy.version(),
                policy == null ? null : policy.severity(),
                tenantId,
                id,
                expectedVersion))
        .query(this::map)
        .optional();
  }

  /** Evidence facts the policy reads (§1.4.5). */
  public record EvidenceFacts(
      @Nullable Integer riskScore,
      int correlatedHigh,
      int correlatedCritical,
      boolean watchlistHit,
      int redFlagClauses) {}

  public EvidenceFacts evidenceFacts(UUID caseId) {
    return jdbc.sql(
            "SELECT"
                + " (SELECT (summary->>'score')::int FROM cases.case_evidence WHERE case_id = ?"
                + "   AND evidence_type = 'RISK_EVALUATION' ORDER BY created_at DESC LIMIT 1) AS risk_score,"
                + " (SELECT count(*) FROM cases.case_evidence WHERE case_id = ? AND evidence_type = 'EVENT'"
                + "   AND final_severity = 'HIGH') AS high,"
                + " (SELECT count(*) FROM cases.case_evidence WHERE case_id = ? AND evidence_type = 'EVENT'"
                + "   AND final_severity = 'CRITICAL') AS critical,"
                + " EXISTS (SELECT 1 FROM cases.case_evidence WHERE case_id = ? AND evidence_type = 'WATCHLIST_HIT')"
                + "   AS watchlist,"
                + " (SELECT COALESCE(sum(jsonb_array_length(COALESCE(summary->'redFlags', '[]'::jsonb))), 0)"
                + "    FROM cases.case_evidence WHERE case_id = ? AND evidence_type = 'EXTRACTION') AS red_flags")
        .params(caseId, caseId, caseId, caseId, caseId)
        .query((rs, i) ->
            new EvidenceFacts(
                (Integer) rs.getObject("risk_score"),
                rs.getInt("high"),
                rs.getInt("critical"),
                rs.getBoolean("watchlist"),
                rs.getInt("red_flags")))
        .single();
  }

  public int nextPolicyRevision(UUID caseId) {
    return jdbc.sql(
            "SELECT COALESCE(max(revision), 0) + 1 FROM cases.policy_evaluations WHERE case_id = ?")
        .param(caseId)
        .query(Integer.class)
        .single();
  }

  public void insertPolicyEvaluation(
      UUID tenantId,
      UUID caseId,
      int revision,
      String version,
      int score,
      String outcome,
      String factorsJson) {
    jdbc.sql(
            "INSERT INTO cases.policy_evaluations (tenant_id, case_id, revision, policy_version,"
                + " policy_score, outcome, factors) VALUES (?,?,?,?,?,?,?::jsonb)"
                + " ON CONFLICT (case_id, revision) DO NOTHING")
        .params(tenantId, caseId, revision, version, score, outcome, factorsJson)
        .update();
  }

  /** A case found by a scheduled sweep (ids only; the work runs under the tenant's RLS). */
  public record DueCase(UUID tenantId, UUID caseId) {}

  public List<DueCase> enrichmentOverdue(int limit) {
    return jdbc.sql("SELECT tenant_id, case_id FROM cases.enrichment_overdue(?)")
        .param(limit)
        .query((rs, i) ->
            new DueCase(rs.getObject("tenant_id", UUID.class), rs.getObject("case_id", UUID.class)))
        .list();
  }

  public List<DueCase> clearedWithoutNewEvidence(int days, int limit) {
    return jdbc.sql("SELECT tenant_id, case_id FROM cases.cleared_without_new_evidence(?, ?)")
        .params(days, limit)
        .query((rs, i) ->
            new DueCase(rs.getObject("tenant_id", UUID.class), rs.getObject("case_id", UUID.class)))
        .list();
  }

  /** Records a transition unless (case, key) exists; false when it already did (idempotent). */
  public boolean insertTransition(
      UUID tenantId,
      UUID caseId,
      String key,
      @Nullable CaseStatus from,
      CaseStatus to,
      String triggerType,
      @Nullable String triggerRef,
      int caseVersion) {
    return jdbc.sql(
                "INSERT INTO cases.case_transitions (tenant_id, case_id, transition_key, from_status, to_status,"
                    + " trigger_type, trigger_ref, case_version) VALUES (?,?,?,?,?,?,?,?)"
                    + " ON CONFLICT (case_id, transition_key) DO NOTHING")
            .params(
                Arrays.asList(
                    tenantId,
                    caseId,
                    key,
                    from == null ? null : from.name(),
                    to.name(),
                    triggerType,
                    triggerRef,
                    caseVersion))
            .update()
        == 1;
  }

  public boolean transitionExists(UUID caseId, String key) {
    return jdbc.sql(
            "SELECT EXISTS (SELECT 1 FROM cases.case_transitions WHERE case_id = ? AND transition_key = ?)")
        .params(caseId, key)
        .query(Boolean.class)
        .single();
  }

  /** FR-CASE-08 storage: idempotent by (case, type, ref); false when already attached. */
  public boolean insertEvidence(
      UUID tenantId,
      UUID caseId,
      String type,
      String ref,
      @Nullable String finalSeverity,
      String summaryJson,
      String attachedBy) {
    return jdbc.sql(
                "INSERT INTO cases.case_evidence (tenant_id, case_id, evidence_type, evidence_ref, final_severity,"
                    + " summary, attached_by) VALUES (?,?,?,?,?,?::jsonb,?)"
                    + " ON CONFLICT (case_id, evidence_type, evidence_ref) DO NOTHING")
            .params(
                Arrays.asList(tenantId, caseId, type, ref, finalSeverity, summaryJson, attachedBy))
            .update()
        == 1;
  }

  private static String uuidArray(List<UUID> ids) {
    StringBuilder b = new StringBuilder("{");
    for (int i = 0; i < ids.size(); i++) {
      if (i > 0) {
        b.append(',');
      }
      b.append(ids.get(i));
    }
    return b.append('}').toString();
  }

  private CaseRecord map(ResultSet rs, int row) throws SQLException {
    Array entities = rs.getArray("primary_entity_ids");
    List<UUID> ids =
        entities == null
            ? List.of()
            : Arrays.stream((Object[]) entities.getArray()).map(o -> (UUID) o).toList();
    return new CaseRecord(
        rs.getObject("id", UUID.class),
        rs.getObject("tenant_id", UUID.class),
        rs.getString("case_number"),
        rs.getString("case_type"),
        CaseStatus.valueOf(rs.getString("status")),
        rs.getString("severity"),
        (Integer) rs.getObject("policy_score"),
        rs.getString("policy_version"),
        ids,
        rs.getObject("trigger_event_id", UUID.class),
        rs.getObject("trigger_file_id", UUID.class),
        rs.getString("open_idempotency_key"),
        rs.getObject("previous_case_id", UUID.class),
        rs.getObject("assignee_user_id", UUID.class),
        rs.getString("pending_disposition"),
        rs.getObject("enrichment_deadline", OffsetDateTime.class),
        rs.getObject("resolved_at", OffsetDateTime.class),
        rs.getInt("version"),
        rs.getObject("created_at", OffsetDateTime.class),
        rs.getObject("updated_at", OffsetDateTime.class));
  }
}
