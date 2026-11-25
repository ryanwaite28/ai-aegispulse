package io.aegispulse.cases.service;

import io.aegispulse.cases.domain.CaseRecord;
import io.aegispulse.cases.domain.CaseStatus;
import io.aegispulse.cases.domain.RiskEvaluation;
import io.aegispulse.contracts.envelope.CanonicalEnvelope;
import io.aegispulse.contracts.envelope.Classification;
import io.aegispulse.contracts.envelope.ClassificationStatus;
import io.aegispulse.contracts.envelope.Sensitivity;
import io.aegispulse.contracts.topology.ExchangeName;
import io.aegispulse.platform.config.AegisPlatformProperties;
import io.aegispulse.platform.ids.UuidV7;
import io.aegispulse.platform.logging.LogContext;
import io.aegispulse.platform.outbox.OutboxMessage;
import io.aegispulse.platform.outbox.OutboxRepository;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.slf4j.MDC;
import org.springframework.stereotype.Component;

/**
 * cases domain events on aegispulse.domain through the outbox in the caller's transaction
 * (ADR-0004, §6.7): risk.evaluation.recorded and the case.* family. Ids, statuses and versions
 * only.
 */
@Component
public class CaseEvents {
  private static final Classification CLASSIFICATION =
      new Classification(
          null,
          null,
          null,
          Classification.ClassificationSource.PRODUCER,
          null,
          null,
          null,
          null,
          Sensitivity.CONFIDENTIAL,
          null,
          ClassificationStatus.INGESTED);

  private final OutboxRepository outbox;
  private final String producer;

  public CaseEvents(OutboxRepository outbox, AegisPlatformProperties props) {
    this.outbox = outbox;
    String sha = props.version().matches("^[0-9a-f]{7,40}$") ? props.version() : "0000000";
    this.producer = "aegispulse-" + props.service() + "@" + sha;
  }

  public void riskEvaluationRecorded(RiskEvaluation e) {
    Map<String, @Nullable Object> p = new LinkedHashMap<>();
    p.put("evaluationId", e.id().toString());
    p.put("transactionEventId", e.transactionEventId().toString());
    p.put("transactionId", e.transactionId().toString());
    p.put("score", e.score());
    p.put("band", e.band());
    p.put("factors", e.factors());
    p.put("modelVersion", e.modelVersion());
    p.put("featureVersion", e.featureVersion());
    if (e.caseId() != null) {
      p.put("caseId", e.caseId().toString());
    }
    if (e.suppressedReason() != null) {
      p.put("suppressedReason", e.suppressedReason());
    }
    publish(
        "risk.evaluation.recorded",
        e.tenantId(),
        e.transactionEventId(),
        "risk.evaluation.recorded:" + e.id(),
        p);
  }

  /** case.opened (from = null) or case.transitioned, plus case.escalated / case.resolved. */
  public void caseChanged(CaseRecord c, @Nullable CaseStatus from) {
    Map<String, @Nullable Object> p = new LinkedHashMap<>();
    p.put("caseId", c.id().toString());
    p.put("caseNumber", c.caseNumber());
    p.put("type", c.caseType());
    p.put("severity", c.severity());
    p.put("from", from == null ? null : from.name());
    p.put("to", c.status().name());
    p.put("triggerEventId", c.triggerEventId().toString());
    if (c.triggerFileId() != null) {
      p.put("triggerFileId", c.triggerFileId().toString());
    }
    p.put("entityIds", c.primaryEntityIds().stream().map(UUID::toString).toList());
    if (c.policyScore() != null) {
      p.put("policyScore", c.policyScore());
    }
    if (c.policyVersion() != null) {
      p.put("policyVersion", c.policyVersion());
    }
    p.put("version", c.version());
    String base = c.id() + ":v" + c.version();
    publish(
        from == null ? "case.opened" : "case.transitioned",
        c.tenantId(),
        c.triggerEventId(),
        "case:" + base,
        p);
    if (c.status() == CaseStatus.ESCALATED) {
      publish("case.escalated", c.tenantId(), c.triggerEventId(), "case.escalated:" + base, p);
    } else if (c.status() == CaseStatus.RESOLVED) {
      publish("case.resolved", c.tenantId(), c.triggerEventId(), "case.resolved:" + base, p);
    }
  }

  /** correlation.requested (FR-CASE-04 → FR-COR-01): case escalated ≥ HIGH, 30-day lookback. */
  public void correlationRequested(CaseRecord c, java.util.List<String> entityIds, int revision) {
    Map<String, @Nullable Object> p = new LinkedHashMap<>();
    p.put("caseId", c.id().toString());
    p.put("entityIds", entityIds);
    p.put("lookbackDays", 30);
    publish(
        "correlation.requested",
        c.tenantId(),
        c.triggerEventId(),
        "correlation.requested:" + c.id() + ":" + revision,
        p);
  }

  /** notification.requested (FR-NOTIF-01): template id, severity, dedup key, flat scalar vars. */
  public void notificationRequested(
      UUID tenantId,
      String templateId,
      String severity,
      String notificationKey,
      Map<String, Object> vars) {
    Map<String, @Nullable Object> p = new LinkedHashMap<>();
    p.put("templateId", templateId);
    p.put("severity", severity);
    p.put("notificationKey", notificationKey);
    p.put("vars", vars);
    publish(
        "notification.requested", tenantId, null, "notification.requested:" + notificationKey, p);
  }

  private void publish(
      String eventType,
      UUID tenantId,
      @Nullable UUID causationId,
      String idempotencyKey,
      Map<String, @Nullable Object> payload) {
    String eventId = UuidV7.next().toString();
    OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
    String correlationId = MDC.get(LogContext.CORRELATION_ID);
    CanonicalEnvelope envelope =
        new CanonicalEnvelope(
            causationId == null ? null : causationId.toString(),
            CLASSIFICATION,
            correlationId != null && correlationId.startsWith("corr-")
                ? correlationId
                : "corr-" + eventId,
            eventId,
            eventType,
            idempotencyKey,
            now,
            now,
            payload,
            producer,
            "1.0.0",
            "service:cases",
            tenantId.toString(),
            null);
    outbox.enqueue(
        new OutboxMessage(ExchangeName.AEGISPULSE_DOMAIN.wireName(), eventType, envelope));
  }
}
