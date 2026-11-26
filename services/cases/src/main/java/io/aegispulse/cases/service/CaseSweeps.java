package io.aegispulse.cases.service;

import io.aegispulse.cases.db.CaseRepository;
import io.aegispulse.cases.domain.CaseRecord;
import io.aegispulse.cases.domain.CaseStatus;
import io.aegispulse.platform.db.TenantScope;
import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.platform.security.AegisPrincipal;
import java.time.Clock;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Scheduled case sweeps (FR-CASE-02; SERVICE token of scheduler-trigger):
 *
 * <ul>
 *   <li>runEnrichmentTimeouts (every 5 min): ENRICHING cases past their 10-min enrichment deadline
 *       get their policy evaluation (one tenant transaction per case).
 *   <li>autoResolveCleared (daily): CLEARED cases with no change and no new evidence for 7 days →
 *       RESOLVED ({@code auto-resolve:v{version}}, TIMER).
 * </ul>
 *
 * Finding due cases is the only cross-tenant read (V7 SECURITY DEFINER finders); batches of 500.
 */
@Service
public class CaseSweeps {
  private static final Logger log = LoggerFactory.getLogger(CaseSweeps.class);
  static final int BATCH = 500;
  public static final int AUTO_RESOLVE_DAYS = 7;

  private final CaseRepository cases;
  private final CaseService caseService;
  private final PolicyEvaluationService policy;
  private final TenantScope scope;
  private final TransactionTemplate tx;
  private final Clock clock;

  public CaseSweeps(
      CaseRepository cases,
      CaseService caseService,
      PolicyEvaluationService policy,
      TenantScope scope,
      PlatformTransactionManager transactions,
      Clock clock) {
    this.cases = cases;
    this.caseService = caseService;
    this.policy = policy;
    this.scope = scope;
    this.tx = new TransactionTemplate(transactions);
    this.clock = clock;
  }

  /**
   * failedCount: cases that threw and were skipped (each in its own transaction); the sweep
   * continues.
   */
  public record Summary(
      int processedCount, int failedCount, Instant startedAt, Instant finishedAt) {}

  public Summary runEnrichmentTimeouts(AegisPrincipal principal) {
    requireService(principal);
    Instant started = Instant.now(clock);
    int done = 0;
    int failed = 0;
    for (CaseRepository.DueCase d : cases.enrichmentOverdue(BATCH)) {
      try {
        CaseRecord after =
            tx.execute(s -> {
              scope.apply(d.tenantId());
              return policy.evaluate(d.tenantId(), d.caseId(), Actor.TIMER);
            });
        if (after != null) {
          done++;
        }
      } catch (RuntimeException e) {
        failed++;
        logFailure("cases.enrichment_timeouts.case_failed", d, e);
      }
    }
    log.atInfo()
        .addKeyValue("processedCount", done)
        .addKeyValue("failedCount", failed)
        .log("cases.enrichment_timeouts");
    return new Summary(done, failed, started, Instant.now(clock));
  }

  public Summary autoResolveCleared(AegisPrincipal principal) {
    requireService(principal);
    Instant started = Instant.now(clock);
    int done = 0;
    int failed = 0;
    for (CaseRepository.DueCase d : cases.clearedWithoutNewEvidence(AUTO_RESOLVE_DAYS, BATCH)) {
      try {
        Boolean resolved =
            tx.execute(s -> {
              scope.apply(d.tenantId());
              CaseRecord c = cases.findById(d.tenantId(), d.caseId()).orElse(null);
              if (c == null || c.status() != CaseStatus.CLEARED) {
                return false;
              }
              caseService.transition(
                  d.tenantId(),
                  d.caseId(),
                  CaseStatus.RESOLVED,
                  "auto-resolve:v" + c.version(),
                  Actor.TIMER,
                  null);
              return true;
            });
        if (Boolean.TRUE.equals(resolved)) {
          done++;
        }
      } catch (RuntimeException e) {
        failed++;
        logFailure("cases.auto_resolve.case_failed", d, e);
      }
    }
    log.atInfo()
        .addKeyValue("processedCount", done)
        .addKeyValue("failedCount", failed)
        .log("cases.auto_resolved");
    return new Summary(done, failed, started, Instant.now(clock));
  }

  /**
   * One bad case must not block the rest of the batch; log ids and the error type only (no case
   * content).
   */
  private static void logFailure(String message, CaseRepository.DueCase d, RuntimeException e) {
    log.atError()
        .addKeyValue("tenantId", d.tenantId())
        .addKeyValue("caseId", d.caseId())
        .addKeyValue("errorType", e.getClass().getSimpleName())
        .log(message);
  }

  private static void requireService(AegisPrincipal principal) {
    if (!(principal instanceof AegisPrincipal.Service)) {
      throw new DomainException.Forbidden(
          "FORBIDDEN", "scheduled sweeps are called by the scheduler only");
    }
  }
}
