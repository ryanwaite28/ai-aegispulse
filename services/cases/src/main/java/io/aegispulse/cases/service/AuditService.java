package io.aegispulse.cases.service;

import io.aegispulse.cases.db.AuditRepository;
import io.aegispulse.cases.domain.AuditHash;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/**
 * Append-only audit chain (FR-AUD-01). Runs inside the caller's tenant transaction: per-tenant
 * advisory lock → head → seq + 1 and prev hash → SHA-256 over the canonical entry → insert + head.
 * The hashed field set is {@link #hashedFields}; verification (FR-AUD-03) recomputes it from rows.
 */
@Service
public class AuditService {
  private static final TypeReference<Map<String, @Nullable Object>> MAP = new TypeReference<>() {};
  private static final DateTimeFormatter MICROS =
      DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSSSSS'Z'");

  private final AuditRepository repo;
  private final JsonMapper json;

  public AuditService(AuditRepository repo, JsonMapper json) {
    this.repo = repo;
    this.json = json;
  }

  /** One audit-worthy change. {@code before}/{@code after} are JSON-able state snapshots. */
  public record Entry(
      UUID tenantId,
      Instant occurredAt,
      Actor actor,
      String action,
      String subjectType,
      String subjectId,
      @Nullable UUID triggerEventId,
      @Nullable UUID triggerFileId,
      @Nullable String modelVersion,
      @Nullable String ruleVersion,
      @Nullable Map<String, @Nullable Object> before,
      @Nullable Map<String, @Nullable Object> after,
      @Nullable UUID sourceEventId) {}

  public record Appended(long seq, String hash) {}

  /**
   * Appends unless {@code e.sourceEventId()} is already in the chain (FR-AUD-02 idempotency,
   * checked under the chain lock so concurrent deliveries cannot both append). Empty for a
   * duplicate.
   */
  @Transactional(propagation = Propagation.MANDATORY)
  public java.util.Optional<Appended> appendIfNew(Entry e) {
    repo.lockChain(e.tenantId());
    if (e.sourceEventId() != null && repo.sourceEventRecorded(e.tenantId(), e.sourceEventId())) {
      return java.util.Optional.empty();
    }
    return java.util.Optional.of(append(e));
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public Appended append(Entry e) {
    repo.lockChain(e.tenantId());
    AuditRepository.Head head =
        repo.head(e.tenantId()).orElse(new AuditRepository.Head(0, AuditHash.GENESIS));
    long seq = head.lastSeq() + 1;
    OffsetDateTime at = e.occurredAt().truncatedTo(ChronoUnit.MICROS).atOffset(ZoneOffset.UTC);
    String before = e.before() == null ? null : json.writeValueAsString(e.before());
    String after = e.after() == null ? null : json.writeValueAsString(e.after());
    AuditRepository.Row draft =
        new AuditRepository.Row(
            e.tenantId(),
            seq,
            at,
            e.actor().type(),
            e.actor().id(),
            e.actor().actingAs(),
            e.action(),
            e.subjectType(),
            e.subjectId(),
            e.triggerEventId(),
            e.triggerFileId(),
            e.modelVersion(),
            e.ruleVersion(),
            before,
            after,
            e.sourceEventId(),
            head.lastHash(),
            "");
    String hash = AuditHash.hash(hashedFields(draft), head.lastHash());
    repo.insert(
        new AuditRepository.Row(
            draft.tenantId(),
            seq,
            at,
            draft.actorType(),
            draft.actorId(),
            draft.actingAs(),
            draft.action(),
            draft.subjectType(),
            draft.subjectId(),
            draft.triggerEventId(),
            draft.triggerFileId(),
            draft.modelVersion(),
            draft.ruleVersion(),
            before,
            after,
            draft.sourceEventId(),
            head.lastHash(),
            hash));
    return new Appended(seq, hash);
  }

  /**
   * The entry as hashed: every stored column except hash/id/created_at, JSON states parsed back.
   */
  public Map<String, @Nullable Object> hashedFields(AuditRepository.Row r) {
    Map<String, @Nullable Object> m = new LinkedHashMap<>();
    m.put("tenantId", r.tenantId().toString());
    m.put("seq", r.seq());
    m.put("occurredAt", MICROS.format(r.occurredAt().withOffsetSameInstant(ZoneOffset.UTC)));
    m.put("actorType", r.actorType());
    m.put("actorId", r.actorId());
    m.put("actingAs", r.actingAs());
    m.put("action", r.action());
    m.put("subjectType", r.subjectType());
    m.put("subjectId", r.subjectId());
    m.put("triggerEventId", r.triggerEventId() == null ? null : r.triggerEventId().toString());
    m.put("triggerFileId", r.triggerFileId() == null ? null : r.triggerFileId().toString());
    m.put("modelVersion", r.modelVersion());
    m.put("ruleVersion", r.ruleVersion());
    m.put("before", r.beforeJson() == null ? null : json.readValue(r.beforeJson(), MAP));
    m.put("after", r.afterJson() == null ? null : json.readValue(r.afterJson(), MAP));
    m.put("sourceEventId", r.sourceEventId() == null ? null : r.sourceEventId().toString());
    m.put("prevHash", r.prevHash());
    return m;
  }
}
