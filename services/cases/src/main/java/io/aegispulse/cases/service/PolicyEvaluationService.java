package io.aegispulse.cases.service;

import io.aegispulse.cases.db.CaseRepository;
import io.aegispulse.cases.domain.CaseRecord;
import io.aegispulse.cases.domain.CaseStatus;
import io.aegispulse.cases.domain.PolicyV1;
import io.aegispulse.platform.errors.DomainException;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;

/**
 * FR-CASE-04 policy evaluation (spec FR-CASE-02-04-policy-sweeps). On an ENRICHING case, inside the
 * caller's tenant transaction:
 *
 * <ol>
 *   <li>read the evidence facts and apply {@link PolicyV1} → policy_evaluations revision n;
 *   <li>ENRICHING → POLICY_EVALUATED ({@code policy:n}) with policy score, version and severity;
 *   <li>POLICY_EVALUATED → ESCALATED | CLEARED ({@code outcome:n});
 *   <li>escalation with severity ≥ HIGH emits correlation.requested (FR-COR-01, ≤ 50 entities,
 *       30-day lookback); CRITICAL also emits notification.requested N-01.
 * </ol>
 *
 * Each step carries its own transition key, so a duplicate trigger adds nothing (FR-CASE-07).
 */
@Service
public class PolicyEvaluationService {
  private static final Logger log = LoggerFactory.getLogger(PolicyEvaluationService.class);
  private static final int MAX_CORRELATION_ENTITIES = 50;

  private final CaseRepository cases;
  private final CaseService caseService;
  private final CaseEvents events;
  private final JsonMapper json;

  public PolicyEvaluationService(
      CaseRepository cases, CaseService caseService, CaseEvents events, JsonMapper json) {
    this.cases = cases;
    this.caseService = caseService;
    this.events = events;
    this.json = json;
  }

  @Transactional(propagation = Propagation.MANDATORY)
  public CaseRecord evaluate(UUID tenantId, UUID caseId, Actor actor) {
    CaseRecord current =
        cases
            .findById(tenantId, caseId)
            .orElseThrow(() -> new DomainException.NotFound("CASE_NOT_FOUND", "case not found"));
    if (current.status() != CaseStatus.ENRICHING) {
      return current; // already evaluated by a concurrent or earlier trigger
    }
    int revision = cases.nextPolicyRevision(caseId);
    CaseRepository.EvidenceFacts f = cases.evidenceFacts(caseId);
    PolicyV1.Result r =
        PolicyV1.evaluate(
            new PolicyV1.Inputs(
                current.caseType(),
                f.riskScore(),
                f.correlatedHigh(),
                f.correlatedCritical(),
                f.watchlistHit(),
                f.redFlagClauses()));
    cases.insertPolicyEvaluation(
        tenantId,
        caseId,
        revision,
        PolicyV1.VERSION,
        r.score(),
        r.outcome(),
        json.writeValueAsString(r.factorsAsJson()));
    CaseRepository.PolicyResult policy =
        new CaseRepository.PolicyResult(r.score(), PolicyV1.VERSION, r.severity());
    caseService.transition(
        tenantId, caseId, CaseStatus.POLICY_EVALUATED, "policy:" + revision, actor, null, policy);
    CaseStatus outcome = CaseStatus.valueOf(r.outcome());
    CaseRecord done =
        caseService.transition(tenantId, caseId, outcome, "outcome:" + revision, actor, null);
    if (outcome == CaseStatus.ESCALATED
        && ("HIGH".equals(r.severity()) || "CRITICAL".equals(r.severity()))) {
      List<String> entities =
          done.primaryEntityIds().stream()
              .limit(MAX_CORRELATION_ENTITIES)
              .map(UUID::toString)
              .toList();
      events.correlationRequested(done, entities, revision);
      if ("CRITICAL".equals(r.severity())) {
        events.notificationRequested(
            tenantId,
            "N-01",
            "CRITICAL",
            "case-escalated:" + caseId + ":" + revision,
            Map.of(
                "caseId", caseId.toString(),
                "caseNumber", done.caseNumber(),
                "type", done.caseType(),
                "entityName", entities.isEmpty() ? "n/a" : entities.getFirst(),
                "policyScore", r.score()));
      }
    }
    log.atInfo()
        .addKeyValue("tenantId", tenantId)
        .addKeyValue("caseId", caseId)
        .addKeyValue("revision", revision)
        .addKeyValue("policyScore", r.score())
        .addKeyValue("outcome", r.outcome())
        .addKeyValue("severity", r.severity())
        .log("case.policy.evaluated");
    return done;
  }
}
