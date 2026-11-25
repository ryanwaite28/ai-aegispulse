package io.aegispulse.cases.db;

import io.aegispulse.cases.domain.AuditFilter;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** cases.audit_log + audit_chain_heads (FR-AUD-01), under tenant RLS; the role can only append. */
@Repository
public class AuditRepository {
  private final JdbcClient jdbc;

  public AuditRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public record Head(long lastSeq, String lastHash) {}

  /** A chain with entries not yet verified by the nightly job. */
  public record PendingChain(UUID tenantId, long lastSeq, long verifiedSeq) {}

  public record Stored(UUID id, Row row) {}

  public record Row(
      UUID tenantId,
      long seq,
      OffsetDateTime occurredAt,
      String actorType,
      String actorId,
      @Nullable String actingAs,
      String action,
      String subjectType,
      String subjectId,
      @Nullable UUID triggerEventId,
      @Nullable UUID triggerFileId,
      @Nullable String modelVersion,
      @Nullable String ruleVersion,
      @Nullable String beforeJson,
      @Nullable String afterJson,
      @Nullable UUID sourceEventId,
      String prevHash,
      String hash) {}

  /** Serializes appends per tenant until the transaction ends (FR-AUD-01). */
  public void lockChain(UUID tenantId) {
    jdbc.sql("SELECT pg_advisory_xact_lock(hashtextextended('cases.audit:' || ?::text, 0))")
        .param(tenantId)
        .query()
        .singleValue();
  }

  public Optional<Head> head(UUID tenantId) {
    return jdbc.sql("SELECT last_seq, last_hash FROM cases.audit_chain_heads WHERE tenant_id = ?")
        .param(tenantId)
        .query((rs, i) -> new Head(rs.getLong("last_seq"), rs.getString("last_hash")))
        .optional();
  }

  public boolean sourceEventRecorded(UUID tenantId, UUID sourceEventId) {
    return jdbc.sql(
            "SELECT EXISTS (SELECT 1 FROM cases.audit_log WHERE tenant_id = ? AND source_event_id = ?)")
        .params(tenantId, sourceEventId)
        .query(Boolean.class)
        .single();
  }

  public void insert(Row r) {
    jdbc.sql(
            "INSERT INTO cases.audit_log (tenant_id, seq, occurred_at, actor_type, actor_id, acting_as, action,"
                + " subject_type, subject_id, trigger_event_id, trigger_file_id, model_version, rule_version,"
                + " before_state, after_state, source_event_id, prev_hash, hash)"
                + " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?::jsonb,?,?,?)")
        .params(
            Arrays.asList(
                r.tenantId(),
                r.seq(),
                r.occurredAt(),
                r.actorType(),
                r.actorId(),
                r.actingAs(),
                r.action(),
                r.subjectType(),
                r.subjectId(),
                r.triggerEventId(),
                r.triggerFileId(),
                r.modelVersion(),
                r.ruleVersion(),
                r.beforeJson(),
                r.afterJson(),
                r.sourceEventId(),
                r.prevHash(),
                r.hash()))
        .update();
    jdbc.sql(
            "INSERT INTO cases.audit_chain_heads (tenant_id, last_seq, last_hash) VALUES (?,?,?)"
                + " ON CONFLICT (tenant_id) DO UPDATE SET last_seq = EXCLUDED.last_seq, last_hash = EXCLUDED.last_hash")
        .params(r.tenantId(), r.seq(), r.hash())
        .update();
  }

  private static final String COLUMNS =
      "id, tenant_id, seq, occurred_at, actor_type, actor_id, acting_as, action, subject_type, subject_id,"
          + " trigger_event_id, trigger_file_id, model_version, rule_version, before_state::text AS b,"
          + " after_state::text AS a, source_event_id, prev_hash, hash";

  public List<Stored> list(UUID tenantId, AuditFilter f, @Nullable Long beforeSeq, int limit) {
    StringBuilder sql =
        new StringBuilder("SELECT " + COLUMNS + " FROM cases.audit_log WHERE tenant_id = ?");
    List<@Nullable Object> params = new ArrayList<>(List.of(tenantId));
    if (f.subjectType() != null) {
      sql.append(" AND subject_type = ?");
      params.add(f.subjectType());
    }
    if (f.subjectId() != null) {
      sql.append(" AND subject_id = ?");
      params.add(f.subjectId());
    }
    if (f.actorId() != null) {
      sql.append(" AND actor_id = ?");
      params.add(f.actorId());
    }
    if (f.action() != null) {
      sql.append(" AND action = ?");
      params.add(f.action());
    }
    if (f.from() != null) {
      sql.append(" AND occurred_at >= ?");
      params.add(f.from());
    }
    if (f.to() != null) {
      sql.append(" AND occurred_at <= ?");
      params.add(f.to());
    }
    if (beforeSeq != null) {
      sql.append(" AND seq < ?");
      params.add(beforeSeq);
    }
    sql.append(" ORDER BY seq DESC LIMIT ?");
    params.add(limit);
    return jdbc.sql(sql.toString()).params(params).query(this::stored).list();
  }

  /** Rows seq ∈ [from, to] in order (verification reads the previous row too, for the link). */
  public List<Stored> range(UUID tenantId, long fromSeq, long toSeq) {
    return jdbc.sql(
            "SELECT "
                + COLUMNS
                + " FROM cases.audit_log WHERE tenant_id = ? AND seq BETWEEN ? AND ? ORDER BY seq")
        .params(tenantId, fromSeq, toSeq)
        .query(this::stored)
        .list();
  }

  /**
   * Cross-tenant listing for the nightly job (SECURITY DEFINER cases.audit_chains_to_verify,
   * ADR-0016).
   */
  public List<PendingChain> chainsToVerify() {
    return jdbc.sql("SELECT tenant_id, last_seq, verified_seq FROM cases.audit_chains_to_verify()")
        .query((rs, i) ->
            new PendingChain(
                rs.getObject("tenant_id", UUID.class),
                rs.getLong("last_seq"),
                rs.getLong("verified_seq")))
        .list();
  }

  public void markVerified(UUID tenantId, long seq) {
    jdbc.sql(
            "UPDATE cases.audit_chain_heads SET verified_seq = GREATEST(verified_seq, ?) WHERE tenant_id = ?")
        .params(seq, tenantId)
        .update();
  }

  private Stored stored(ResultSet rs, int i) throws SQLException {
    return new Stored(
        rs.getObject("id", UUID.class),
        new Row(
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
            rs.getString("hash")));
  }
}
