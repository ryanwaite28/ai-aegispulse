package io.aegispulse.cases.domain;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * Read models of a case's history (FR-CASE-05): transitions, evidence, notes, dispositions, policy.
 */
public final class CaseWork {
  private CaseWork() {}

  public record Transition(
      UUID id,
      @Nullable String fromStatus,
      String toStatus,
      String triggerType,
      @Nullable String triggerRef,
      int caseVersion,
      OffsetDateTime createdAt) {}

  public record Evidence(
      UUID id,
      String evidenceType,
      String evidenceRef,
      @Nullable String finalSeverity,
      Map<String, @Nullable Object> summary,
      String attachedBy,
      OffsetDateTime createdAt) {}

  public record Note(
      UUID id,
      UUID caseId,
      UUID authorId,
      String body,
      OffsetDateTime lockedAt,
      OffsetDateTime createdAt) {}

  public record Disposition(
      UUID id,
      UUID caseId,
      String disposition,
      String rationale,
      UUID analystId,
      List<String> modelVersions,
      List<String> ruleVersions,
      @Nullable String policyVersion,
      OffsetDateTime createdAt) {}

  public record PolicyEvaluation(
      UUID id,
      int revision,
      String policyVersion,
      int policyScore,
      String outcome,
      Map<String, @Nullable Object> factors,
      OffsetDateTime createdAt) {}

  public record Timeline(
      UUID caseId,
      List<Transition> transitions,
      List<Evidence> evidence,
      List<Note> notes,
      List<Disposition> dispositions) {}

  /** FR-CASE-05 list filters (all optional). */
  public record Filter(
      @Nullable String status,
      @Nullable String caseType,
      @Nullable String severity,
      @Nullable UUID assigneeUserId,
      @Nullable UUID entityId) {}

  public record EvidenceItem(
      String evidenceType,
      String evidenceRef,
      @Nullable String finalSeverity,
      @Nullable Map<String, @Nullable Object> summary) {}
}
