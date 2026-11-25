package io.aegispulse.cases.service;

import io.aegispulse.cases.db.AuditRepository;
import io.aegispulse.cases.domain.AuditEntry;
import io.aegispulse.cases.domain.AuditFilter;
import io.aegispulse.cases.domain.AuditHash;
import io.aegispulse.cases.domain.AuditSubjects;
import io.aegispulse.cases.domain.ChainVerification;
import io.aegispulse.contracts.envelope.CanonicalEnvelope;
import io.aegispulse.platform.db.TenantScope;
import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.platform.security.AegisPrincipal;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/**
 * Audit log ingest, reads and verification (FR-AUD-02/03; spec FR-AUD-01-03-audit-log).
 *
 * <ul>
 *   <li>ingestAuditEvent (cases.audit-ingest.q): one chain entry per source event, idempotent by
 *       source eventId under the chain lock; tenantless (platform) events go to the platform
 *       tenant.
 *   <li>listAuditEntries: COMPLIANCE_AUDITOR / TENANT_ADMIN of the tenant; filters + seq keyset.
 *   <li>verifyAuditChain: recompute every hash and link in [fromSeq, toSeq] (chunks of 1,000); a
 *       SERVICE caller without tenantId (the nightly job) verifies every chain from its
 *       verified_seq and emits notification.requested N-06 for a broken one.
 * </ul>
 */
@Service
public class AuditLogService {
  private static final Logger log = LoggerFactory.getLogger(AuditLogService.class);
  private static final TypeReference<Map<String, @Nullable Object>> MAP = new TypeReference<>() {};
  public static final UUID PLATFORM_TENANT =
      UUID.fromString("00000000-0000-0000-0000-000000000001");
  private static final int DEFAULT_LIMIT = 50;
  private static final int CHUNK = 1_000;

  private final AuditRepository repo;
  private final AuditService audit;
  private final CaseEvents events;
  private final TenantScope scope;
  private final JsonMapper json;
  private final TransactionTemplate tx;

  public AuditLogService(
      AuditRepository repo,
      AuditService audit,
      CaseEvents events,
      TenantScope scope,
      JsonMapper json,
      PlatformTransactionManager transactions) {
    this.repo = repo;
    this.audit = audit;
    this.events = events;
    this.scope = scope;
    this.json = json;
    this.tx = new TransactionTemplate(transactions);
  }

  /** FR-AUD-02. Returns false for a duplicate (already chained) or a non-audit event. */
  @Transactional
  public boolean ingestAuditEvent(CanonicalEnvelope e) {
    Optional<AuditSubjects.Mapped> mapped =
        AuditSubjects.map(e.eventType(), e.payload(), e.producer());
    if (mapped.isEmpty()) {
      log.atWarn().addKeyValue("eventType", e.eventType()).log("audit.ingest.ignored");
      return false;
    }
    UUID tenantId = e.tenantId() == null ? PLATFORM_TENANT : UUID.fromString(e.tenantId());
    scope.apply(tenantId);
    AuditSubjects.Mapped m = mapped.get();
    boolean appended =
        audit
            .appendIfNew(
                new AuditService.Entry(
                    tenantId,
                    e.occurredAt().toInstant(),
                    new Actor(m.actorType(), m.actorId(), null),
                    m.action(),
                    m.subjectType(),
                    m.subjectId(),
                    e.causationId() == null ? null : UUID.fromString(e.causationId()),
                    null,
                    null,
                    null,
                    null,
                    e.payload(),
                    UUID.fromString(e.eventId())))
            .isPresent();
    if (appended) {
      log.atInfo()
          .addKeyValue("tenantId", tenantId)
          .addKeyValue("action", m.action())
          .log("audit.ingested");
    }
    return appended;
  }

  public record Page(List<AuditEntry> items, @Nullable String nextCursor) {}

  @Transactional(readOnly = true)
  public Page list(
      AegisPrincipal principal,
      @Nullable UUID actingTenant,
      AuditFilter filter,
      @Nullable Integer limit,
      @Nullable String cursor) {
    UUID tenantId = RiskEvaluationService.tenantFor(principal, actingTenant, "listAuditEntries");
    scope.apply(tenantId);
    int n = limit == null ? DEFAULT_LIMIT : limit;
    List<AuditRepository.Stored> rows = repo.list(tenantId, filter, decodeCursor(cursor), n + 1);
    List<AuditEntry> items = rows.stream().limit(n).map(this::entry).toList();
    String next = rows.size() > n ? encodeCursor(items.getLast().seq()) : null;
    return new Page(items, next);
  }

  /**
   * User (COMPLIANCE_AUDITOR) → own tenant; SERVICE with tenantId → that tenant; SERVICE without →
   * all.
   */
  public ChainVerification verify(
      AegisPrincipal principal,
      @Nullable UUID actingTenant,
      @Nullable UUID tenantId,
      @Nullable Long fromSeq,
      @Nullable Long toSeq) {
    if (principal instanceof AegisPrincipal.Service) {
      return tenantId == null
          ? verifyAllPending()
          : inTenant(tenantId, () -> verifyRange(tenantId, fromSeq, toSeq));
    }
    if (tenantId != null) {
      throw new DomainException.Forbidden(
          "FORBIDDEN", "tenantId is for SERVICE callers; users verify their tenant");
    }
    UUID tenant = RiskEvaluationService.tenantFor(principal, actingTenant, "verifyAuditChain");
    return inTenant(tenant, () -> verifyRange(tenant, fromSeq, toSeq));
  }

  /**
   * Nightly job: each chain from verified_seq + 1 to its head; broken → N-06, verified_seq stays.
   */
  private ChainVerification verifyAllPending() {
    long checked = 0;
    Long firstBroken = null;
    for (AuditRepository.PendingChain c : repo.chainsToVerify()) {
      ChainVerification v =
          inTenant(c.tenantId(), () -> verifyRange(c.tenantId(), c.verifiedSeq() + 1, c.lastSeq()));
      checked += v.checked();
      if (v.valid()) {
        inTenantDo(c.tenantId(), () -> repo.markVerified(c.tenantId(), c.lastSeq()));
      } else {
        Long broken = v.firstBrokenSeq();
        if (firstBroken == null) {
          firstBroken = broken;
        }
        inTenantDo(
            c.tenantId(),
            () ->
                events.notificationRequested(
                    c.tenantId(),
                    "N-06",
                    "CRITICAL",
                    "N-06:" + c.tenantId() + ":" + broken,
                    Map.of(
                        "tenantSlug",
                        c.tenantId().toString(),
                        "seq",
                        broken == null ? 0 : broken)));
        log.atError()
            .addKeyValue("tenantId", c.tenantId())
            .addKeyValue("firstBrokenSeq", broken)
            .log("audit.chain.broken");
      }
    }
    return new ChainVerification(firstBroken == null, checked, firstBroken);
  }

  /**
   * Recomputes hashes and links for seq ∈ [from, to] (defaults: 1 … head). Must run in the tenant
   * scope.
   */
  private ChainVerification verifyRange(
      UUID tenantId, @Nullable Long fromSeq, @Nullable Long toSeq) {
    long head = repo.head(tenantId).map(AuditRepository.Head::lastSeq).orElse(0L);
    long from = fromSeq == null ? 1 : fromSeq;
    long to = toSeq == null ? head : Math.min(toSeq, head);
    if (from > to) {
      return ChainVerification.ok(0);
    }
    String prev = AuditHash.GENESIS;
    if (from > 1) {
      List<AuditRepository.Stored> before = repo.range(tenantId, from - 1, from - 1);
      if (before.isEmpty()) {
        return new ChainVerification(false, 0, from - 1);
      }
      prev = before.getFirst().row().hash();
    }
    long expected = from;
    long checked = 0;
    while (expected <= to) {
      List<AuditRepository.Stored> chunk =
          repo.range(tenantId, expected, Math.min(to, expected + CHUNK - 1));
      for (AuditRepository.Stored s : chunk) {
        AuditRepository.Row r = s.row();
        boolean ok =
            r.seq() == expected
                && r.prevHash().equals(prev)
                && AuditHash.hash(audit.hashedFields(r), prev).equals(r.hash());
        if (!ok) {
          return new ChainVerification(false, checked, expected);
        }
        prev = r.hash();
        expected++;
        checked++;
      }
      if (chunk.isEmpty()) {
        return new ChainVerification(false, checked, expected); // a gap
      }
    }
    return ChainVerification.ok(checked);
  }

  private void inTenantDo(UUID tenantId, Runnable work) {
    tx.executeWithoutResult(s -> {
      scope.apply(tenantId);
      work.run();
    });
  }

  private <T> T inTenant(UUID tenantId, java.util.function.Supplier<T> work) {
    return java.util.Objects.requireNonNull(
        tx.execute(s -> {
          scope.apply(tenantId);
          return work.get();
        }));
  }

  private AuditEntry entry(AuditRepository.Stored s) {
    AuditRepository.Row r = s.row();
    return new AuditEntry(
        s.id(),
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
        r.beforeJson() == null ? null : json.readValue(r.beforeJson(), MAP),
        r.afterJson() == null ? null : json.readValue(r.afterJson(), MAP),
        r.prevHash(),
        r.hash());
  }

  static String encodeCursor(long seq) {
    return Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(Long.toString(seq).getBytes(StandardCharsets.UTF_8));
  }

  static @Nullable Long decodeCursor(@Nullable String cursor) {
    if (cursor == null) {
      return null;
    }
    try {
      return Long.parseLong(
          new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8));
    } catch (IllegalArgumentException e) {
      throw new DomainException.Validation(
          "VALIDATION_ERROR",
          "request failed validation",
          List.of(new DomainException.ErrorDetail("cursor", "invalid cursor")));
    }
  }
}
