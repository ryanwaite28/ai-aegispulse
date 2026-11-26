package io.aegispulse.cases.service;

import io.aegispulse.cases.db.CaseRepository;
import io.aegispulse.cases.db.RiskEvaluationRepository;
import io.aegispulse.cases.domain.AccessPolicy;
import io.aegispulse.cases.domain.RiskEvaluation;
import io.aegispulse.platform.db.TenantScope;
import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.platform.ids.UuidV7;
import io.aegispulse.platform.security.AegisPrincipal;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;

/**
 * recordRiskEvaluation (FR-TXN-05) and getTransactionEvaluation (FR-TXN-06). Recording is
 * idempotent by (tenant, risk-eval:{eventId}): the evaluation, a TRANSACTION_RISK case when score ≥
 * 70 (suppressed with TENANT_SUSPENDED when the saga reports a non-ACTIVE tenant), its evidence,
 * the audit entry and risk.evaluation.recorded commit in one transaction.
 */
@Service
public class RiskEvaluationService {
  private static final Logger log = LoggerFactory.getLogger(RiskEvaluationService.class);
  public static final int CASE_THRESHOLD = 70;

  private final RiskEvaluationRepository evaluations;
  private final CaseRepository cases;
  private final CaseService caseService;
  private final PolicyEvaluationService policy;
  private final AuditService audit;
  private final CaseEvents events;
  private final TenantScope scope;
  private final JsonMapper json;
  private final Clock clock;

  public RiskEvaluationService(
      RiskEvaluationRepository evaluations,
      CaseRepository cases,
      CaseService caseService,
      PolicyEvaluationService policy,
      AuditService audit,
      CaseEvents events,
      TenantScope scope,
      JsonMapper json,
      Clock clock) {
    this.evaluations = evaluations;
    this.cases = cases;
    this.caseService = caseService;
    this.policy = policy;
    this.audit = audit;
    this.events = events;
    this.scope = scope;
    this.json = json;
    this.clock = clock;
  }

  @Transactional
  public RiskEvaluation record(AegisPrincipal principal, Commands.RecordRiskEvaluation cmd) {
    if (!(principal instanceof AegisPrincipal.Service)) {
      throw new DomainException.Forbidden(
          "FORBIDDEN", "recordRiskEvaluation is called by the saga only");
    }
    UUID tenantId = cmd.tenantId();
    scope.apply(tenantId);
    evaluations.lockKey(tenantId, cmd.idempotencyKey());
    Optional<RiskEvaluation> existing = evaluations.findByKey(tenantId, cmd.idempotencyKey());
    if (existing.isPresent()) {
      return existing.get();
    }
    List<Map<String, @Nullable Object>> hits = new ArrayList<>();
    LinkedHashSet<UUID> entities = new LinkedHashSet<>();
    for (Commands.WatchlistHit h :
        cmd.watchlistHits() == null ? List.<Commands.WatchlistHit>of() : cmd.watchlistHits()) {
      Map<String, @Nullable Object> m = new LinkedHashMap<>();
      m.put("watchlistId", h.watchlistId().toString());
      m.put("watchlistName", h.watchlistName());
      m.put("severityFloor", h.severityFloor());
      m.put("entityId", h.entityId().toString());
      m.put("counterpartyId", h.counterpartyId());
      hits.add(m);
      entities.add(h.entityId());
    }
    List<Map<String, @Nullable Object>> factors = new ArrayList<>();
    for (Commands.ScoreFactor f : cmd.factors()) {
      Map<String, @Nullable Object> m = new LinkedHashMap<>();
      m.put("name", f.name());
      m.put("value", f.value());
      m.put("contribution", f.contribution());
      factors.add(m);
    }
    boolean caseWorthy = cmd.score() >= CASE_THRESHOLD;
    boolean active =
        "ACTIVE".equals(cmd.tenantStatus()); // fail closed: anything but ACTIVE suppresses
    UUID evaluationId = UuidV7.next();
    UUID caseId = null;
    if (caseWorthy && active) {
      CaseService.Opened opened =
          caseService.open(
              new CaseService.NewCase(
                  tenantId,
                  "TRANSACTION_RISK",
                  cmd.score() >= 85 ? "CRITICAL" : "HIGH",
                  cmd.transactionEventId(),
                  null,
                  List.copyOf(entities),
                  "txn-risk:" + cmd.transactionEventId(),
                  null,
                  cmd.modelVersion()),
              Actor.of(principal));
      caseId = opened.caseRow().id();
      cases.insertEvidence(
          tenantId,
          caseId,
          "RISK_EVALUATION",
          evaluationId.toString(),
          cmd.score() >= 85 ? "CRITICAL" : "HIGH",
          json.writeValueAsString(
              Map.of("score", cmd.score(), "band", cmd.band(), "modelVersion", cmd.modelVersion())),
          "ScoreTransactionSaga");
      for (Map<String, @Nullable Object> hit : hits) {
        cases.insertEvidence(
            tenantId,
            caseId,
            "WATCHLIST_HIT",
            String.valueOf(hit.get("watchlistId")) + ":" + hit.get("entityId"),
            String.valueOf(hit.get("severityFloor")),
            json.writeValueAsString(hit),
            "ScoreTransactionSaga");
      }
      if (opened.created()) {
        // Enrichment of a TRANSACTION_RISK case is its evaluation + watchlist hits, attached above
        // in this
        // transaction, so enrichment is complete at open and the policy runs now (FR-CASE-02/04).
        policy.evaluate(tenantId, caseId, Actor.SYSTEM);
      }
    }
    RiskEvaluation draft =
        new RiskEvaluation(
            evaluationId,
            tenantId,
            cmd.idempotencyKey(),
            cmd.transactionEventId(),
            cmd.transactionId(),
            cmd.accountId(),
            cmd.counterpartyId(),
            cmd.score(),
            cmd.band(),
            factors,
            cmd.modelVersion(),
            cmd.featureVersion(),
            hits,
            caseId,
            caseWorthy && !active ? "TENANT_SUSPENDED" : null,
            java.time.OffsetDateTime.now(clock));
    Optional<RiskEvaluation> inserted = evaluations.insert(draft);
    if (inserted.isEmpty()) {
      return evaluations
          .findByKey(tenantId, cmd.idempotencyKey())
          .orElseThrow(
              () -> new DomainException.Conflict("CONFLICT", "concurrent evaluation; retry"));
    }
    RiskEvaluation e = inserted.get();
    Map<String, @Nullable Object> after = new LinkedHashMap<>();
    after.put("score", e.score());
    after.put("band", e.band());
    after.put("caseId", caseId == null ? null : caseId.toString());
    after.put("suppressedReason", e.suppressedReason());
    audit.append(
        new AuditService.Entry(
            tenantId,
            Instant.now(clock),
            Actor.of(principal),
            "RISK_EVALUATION_RECORDED",
            "RISK_EVALUATION",
            e.id().toString(),
            e.transactionEventId(),
            null,
            e.modelVersion(),
            null,
            null,
            after,
            null));
    events.riskEvaluationRecorded(e);
    log.atInfo()
        .addKeyValue("tenantId", tenantId)
        .addKeyValue("evaluationId", e.id())
        .addKeyValue("transactionId", e.transactionId())
        .addKeyValue("score", e.score())
        .addKeyValue("caseId", caseId)
        .addKeyValue("suppressedReason", e.suppressedReason())
        .log("risk.evaluation.recorded");
    return e;
  }

  @Transactional(readOnly = true)
  public RiskEvaluation getTransactionEvaluation(
      AegisPrincipal principal, @Nullable UUID actingTenant, UUID transactionId) {
    UUID tenantId = tenantFor(principal, actingTenant, "getTransactionEvaluation");
    scope.apply(tenantId);
    return evaluations
        .findLatestByTransaction(tenantId, transactionId)
        .orElseThrow(
            () -> new DomainException.NotFound("NOT_FOUND", "no evaluation for this transaction"));
  }

  /** §6.2 acting-tenant rule for user/integration principals (SERVICE principals are refused). */
  static UUID tenantFor(AegisPrincipal principal, @Nullable UUID actingTenant, String action) {
    List<String> roles;
    String ownTenant;
    switch (principal) {
      case AegisPrincipal.User u -> {
        roles = u.roles();
        ownTenant = u.tenantId();
      }
      case AegisPrincipal.Integration i -> {
        roles = i.roles();
        ownTenant = i.tenantId();
      }
      case AegisPrincipal.Service s ->
          throw new DomainException.Forbidden(
              "FORBIDDEN", "this action requires a tenant principal");
    }
    if (!AccessPolicy.allows(action, roles)) {
      throw new DomainException.Forbidden("FORBIDDEN", "role not allowed for " + action);
    }
    if (roles.contains("PLATFORM_ADMIN")) {
      if (actingTenant == null) {
        throw new DomainException.Forbidden(
            "FORBIDDEN", "PLATFORM_ADMIN must name the tenant with X-Aegis-Tenant");
      }
      if ("00000000-0000-0000-0000-000000000001".equals(actingTenant.toString())) {
        throw new DomainException.NotFound("NOT_FOUND", "tenant not found");
      }
      return actingTenant;
    }
    if (actingTenant != null) {
      throw new DomainException.Forbidden("FORBIDDEN", "X-Aegis-Tenant is for PLATFORM_ADMIN only");
    }
    return UUID.fromString(ownTenant);
  }
}
