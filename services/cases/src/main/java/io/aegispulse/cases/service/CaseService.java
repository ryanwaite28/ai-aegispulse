package io.aegispulse.cases.service;

import io.aegispulse.cases.db.CaseRepository;
import io.aegispulse.cases.domain.CaseNumbers;
import io.aegispulse.cases.domain.CaseRecord;
import io.aegispulse.cases.domain.CaseStateMachine;
import io.aegispulse.cases.domain.CaseStatus;
import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.platform.ids.UuidV7;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Case lifecycle core (FR-CASE-01/02/03/07). Runs inside the caller's tenant transaction:
 *
 * <ul>
 *   <li>open: idempotent by (tenant, openIdempotencyKey); numbers AP-{yyyy}-{n}; OPEN is recorded
 *       and audited, then the automatic OPEN → ENRICHING transition (enrichment deadline now + 10
 *       min).
 *   <li>transition: idempotent by (case, transitionKey); validated by {@link CaseStateMachine};
 *       optimistic locking on version (a lost race re-reads and retries up to 3×, then 409
 *       CASE_CONFLICT); transition row + audit entry + case.* outbox events in the same
 *       transaction.
 * </ul>
 */
@Service
public class CaseService {
  private static final Logger log = LoggerFactory.getLogger(CaseService.class);
  public static final Duration ENRICHMENT_TIMEOUT = Duration.ofMinutes(10);
  private static final int MAX_ATTEMPTS = 3;

  private final CaseRepository cases;
  private final AuditService audit;
  private final CaseEvents events;
  private final Clock clock;

  public CaseService(CaseRepository cases, AuditService audit, CaseEvents events, Clock clock) {
    this.cases = cases;
    this.audit = audit;
    this.events = events;
    this.clock = clock;
  }

  public record Opened(CaseRecord caseRow, boolean created) {}

  /** A new case's facts (FR-CASE-01). */
  public record NewCase(
      UUID tenantId,
      String caseType,
      String severity,
      UUID triggerEventId,
      @Nullable UUID triggerFileId,
      List<UUID> primaryEntityIds,
      String openIdempotencyKey,
      @Nullable UUID previousCaseId,
      @Nullable String modelVersion) {}

  @Transactional(propagation = Propagation.MANDATORY)
  public Opened open(NewCase n, Actor actor) {
    Optional<CaseRecord> existing = cases.findByOpenKey(n.tenantId(), n.openIdempotencyKey());
    if (existing.isPresent()) {
      return new Opened(existing.get(), false);
    }
    int year = OffsetDateTime.now(clock).withOffsetSameInstant(ZoneOffset.UTC).getYear();
    String number = CaseNumbers.format(year, cases.nextCaseSequence(n.tenantId(), year));
    Optional<CaseRecord> inserted =
        cases.insertOpen(
            new CaseRepository.NewCase(
                UuidV7.next(),
                n.tenantId(),
                number,
                n.caseType(),
                n.severity(),
                n.primaryEntityIds(),
                n.triggerEventId(),
                n.triggerFileId(),
                n.openIdempotencyKey(),
                n.previousCaseId()));
    if (inserted.isEmpty()) {
      // A concurrent open with the same key committed first (the unique index waited for it).
      return new Opened(
          cases
              .findByOpenKey(n.tenantId(), n.openIdempotencyKey())
              .orElseThrow(
                  () -> new DomainException.Conflict("CASE_CONFLICT", "concurrent open; retry")),
          false);
    }
    CaseRecord opened = inserted.get();
    cases.insertTransition(
        n.tenantId(),
        opened.id(),
        "open",
        null,
        CaseStatus.OPEN,
        actor.triggerType(),
        actor.id(),
        opened.version());
    audit.append(entry(opened, actor, "CASE_OPENED", null, state(opened), n.modelVersion()));
    events.caseChanged(opened, null);
    CaseRecord enriching =
        transition(
            opened.tenantId(),
            opened.id(),
            CaseStatus.ENRICHING,
            "enrich:open",
            Actor.SYSTEM,
            OffsetDateTime.now(clock).plus(ENRICHMENT_TIMEOUT));
    log.atInfo()
        .addKeyValue("tenantId", n.tenantId())
        .addKeyValue("caseId", opened.id())
        .addKeyValue("caseNumber", opened.caseNumber())
        .addKeyValue("type", n.caseType())
        .addKeyValue("severity", n.severity())
        .log("case.opened");
    return new Opened(enriching, true);
  }

  /**
   * Moves a case to {@code to} unless {@code transitionKey} was already applied (then returns the
   * current case: duplicates produce no transition, audit entry or event, FR-CASE-07).
   */
  @Transactional(propagation = Propagation.MANDATORY)
  public CaseRecord transition(
      UUID tenantId,
      UUID caseId,
      CaseStatus to,
      String transitionKey,
      Actor actor,
      @Nullable OffsetDateTime enrichmentDeadline) {
    for (int attempt = 1; ; attempt++) {
      CaseRecord current =
          cases
              .findById(tenantId, caseId)
              .orElseThrow(() -> new DomainException.NotFound("CASE_NOT_FOUND", "case not found"));
      if (cases.transitionExists(caseId, transitionKey)) {
        return current;
      }
      CaseStateMachine.require(current.status(), to);
      Optional<CaseRecord> updated =
          cases.updateStatus(
              tenantId,
              caseId,
              current.version(),
              to,
              to == CaseStatus.ENRICHING ? enrichmentDeadline : null);
      if (updated.isEmpty()) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new DomainException.Conflict(
              "CASE_CONFLICT", "the case changed concurrently; retry");
        }
        continue;
      }
      CaseRecord next = updated.get();
      if (!cases.insertTransition(
          tenantId,
          caseId,
          transitionKey,
          current.status(),
          to,
          actor.triggerType(),
          actor.id(),
          next.version())) {
        // Same key committed by a concurrent writer after our check: undo by failing the
        // transaction.
        throw new DomainException.Conflict(
            "CASE_CONFLICT", "transition already applied concurrently");
      }
      audit.append(entry(next, actor, "CASE_TRANSITION", state(current), state(next), null));
      events.caseChanged(next, current.status());
      return next;
    }
  }

  static Map<String, @Nullable Object> state(CaseRecord c) {
    Map<String, @Nullable Object> m = new LinkedHashMap<>();
    m.put("status", c.status().name());
    m.put("severity", c.severity());
    m.put("version", c.version());
    m.put("policyScore", c.policyScore());
    m.put("assigneeUserId", c.assigneeUserId() == null ? null : c.assigneeUserId().toString());
    return m;
  }

  private AuditService.Entry entry(
      CaseRecord c,
      Actor actor,
      String action,
      @Nullable Map<String, @Nullable Object> before,
      Map<String, @Nullable Object> after,
      @Nullable String modelVersion) {
    return new AuditService.Entry(
        c.tenantId(),
        Instant.now(clock),
        actor,
        action,
        "CASE",
        c.id().toString(),
        c.triggerEventId(),
        c.triggerFileId(),
        modelVersion,
        c.policyVersion(),
        before,
        after,
        null);
  }
}
