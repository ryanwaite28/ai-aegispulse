package io.aegispulse.cases.db;

import java.time.OffsetDateTime;
import java.util.Arrays;
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
}
