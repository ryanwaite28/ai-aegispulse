package io.aegispulse.cases.adapters.http;

import io.aegispulse.cases.domain.CaseRecord;
import io.aegispulse.cases.domain.RiskEvaluation;
import io.aegispulse.cases.service.CaseOpening;
import io.aegispulse.cases.service.CaseSweeps;
import io.aegispulse.cases.service.Commands;
import io.aegispulse.cases.service.RiskEvaluationService;
import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.platform.security.AegisPrincipal;
import io.aegispulse.platform.security.ServiceActionAuthorizer;
import jakarta.validation.Valid;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Internal cases actions of slice 8c (§6.2): recordRiskEvaluation, openCase (orchestrator SERVICE
 * token), getTransactionEvaluation (gateway with the user token). Transport only.
 */
@RestController
@RequestMapping("/internal/v1")
class CasesController {
  private final ServiceActionAuthorizer authorizer;
  private final RiskEvaluationService evaluations;
  private final CaseOpening opening;
  private final CaseSweeps sweeps;

  CasesController(
      ServiceActionAuthorizer authorizer,
      RiskEvaluationService evaluations,
      CaseOpening opening,
      CaseSweeps sweeps) {
    this.authorizer = authorizer;
    this.evaluations = evaluations;
    this.opening = opening;
    this.sweeps = sweeps;
  }

  /** Empty payload (Record&lt;string, never&gt;). */
  record NoInput() {}

  @PostMapping("/runEnrichmentTimeouts")
  Success<CaseSweeps.Summary> runEnrichmentTimeouts(
      @Nullable Authentication auth, @RequestBody NoInput body) {
    return Success.of(
        sweeps.runEnrichmentTimeouts(
            authorizer.requireAction(auth, "cases.runEnrichmentTimeouts")));
  }

  @PostMapping("/autoResolveCleared")
  Success<CaseSweeps.Summary> autoResolveCleared(
      @Nullable Authentication auth, @RequestBody NoInput body) {
    return Success.of(
        sweeps.autoResolveCleared(authorizer.requireAction(auth, "cases.autoResolveCleared")));
  }

  @PostMapping("/recordRiskEvaluation")
  Success<Map<String, @Nullable Object>> recordRiskEvaluation(
      @Nullable Authentication auth, @Valid @RequestBody Commands.RecordRiskEvaluation body) {
    AegisPrincipal p = authorizer.requireAction(auth, "cases.recordRiskEvaluation");
    return Success.of(view(evaluations.record(p, body)));
  }

  @PostMapping("/openCase")
  Success<Map<String, @Nullable Object>> openCase(
      @Nullable Authentication auth, @Valid @RequestBody Commands.OpenCase body) {
    AegisPrincipal p = authorizer.requireAction(auth, "cases.openCase");
    return Success.of(view(opening.open(p, body)));
  }

  @PostMapping("/getTransactionEvaluation")
  Success<Map<String, @Nullable Object>> getTransactionEvaluation(
      @Nullable Authentication auth,
      @RequestHeader(value = "X-Aegis-Tenant", required = false) @Nullable String acting,
      @Valid @RequestBody Commands.GetTransactionEvaluation body) {
    AegisPrincipal p = authorizer.requireAction(auth, "cases.getTransactionEvaluation");
    return Success.of(
        view(evaluations.getTransactionEvaluation(p, actingTenant(acting), body.transactionId())));
  }

  static @Nullable UUID actingTenant(@Nullable String raw) {
    if (raw == null || raw.isBlank()) {
      return null;
    }
    try {
      return UUID.fromString(raw.strip());
    } catch (IllegalArgumentException e) {
      throw new DomainException.Validation(
          "VALIDATION_ERROR",
          "request failed validation",
          List.of(new DomainException.ErrorDetail("X-Aegis-Tenant", "must be a UUID")));
    }
  }

  /** Contract RiskEvaluation. */
  static Map<String, @Nullable Object> view(RiskEvaluation e) {
    Map<String, @Nullable Object> m = new LinkedHashMap<>();
    m.put("id", e.id().toString());
    m.put("tenantId", e.tenantId().toString());
    m.put("transactionEventId", e.transactionEventId().toString());
    m.put("transactionId", e.transactionId().toString());
    m.put("accountId", e.accountId());
    m.put("counterpartyId", e.counterpartyId());
    m.put("score", e.score());
    m.put("band", e.band());
    m.put("factors", e.factors());
    m.put("modelVersion", e.modelVersion());
    m.put("featureVersion", e.featureVersion());
    m.put("watchlistHits", e.watchlistHits());
    m.put("caseId", e.caseId() == null ? null : e.caseId().toString());
    m.put("suppressedReason", e.suppressedReason());
    m.put("createdAt", e.createdAt().toInstant().toString());
    return m;
  }

  /** Contract Case. */
  static Map<String, @Nullable Object> view(CaseRecord c) {
    Map<String, @Nullable Object> m = new LinkedHashMap<>();
    m.put("id", c.id().toString());
    m.put("tenantId", c.tenantId().toString());
    m.put("caseNumber", c.caseNumber());
    m.put("caseType", c.caseType());
    m.put("status", c.status().name());
    m.put("severity", c.severity());
    m.put("policyScore", c.policyScore());
    m.put("policyVersion", c.policyVersion());
    m.put("primaryEntityIds", c.primaryEntityIds().stream().map(UUID::toString).toList());
    m.put("triggerEventId", c.triggerEventId().toString());
    m.put("triggerFileId", c.triggerFileId() == null ? null : c.triggerFileId().toString());
    m.put("previousCaseId", c.previousCaseId() == null ? null : c.previousCaseId().toString());
    m.put("assigneeUserId", c.assigneeUserId() == null ? null : c.assigneeUserId().toString());
    m.put("pendingDisposition", c.pendingDisposition());
    m.put("version", c.version());
    m.put("resolvedAt", c.resolvedAt() == null ? null : c.resolvedAt().toInstant().toString());
    m.put("createdAt", c.createdAt().toInstant().toString());
    m.put("updatedAt", c.updatedAt().toInstant().toString());
    return m;
  }
}
