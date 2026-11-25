package io.aegispulse.cases.domain;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** A case as stored (cases.cases, FR-CASE-01). */
public record CaseRecord(
    UUID id,
    UUID tenantId,
    String caseNumber,
    String caseType,
    CaseStatus status,
    String severity,
    @Nullable Integer policyScore,
    @Nullable String policyVersion,
    List<UUID> primaryEntityIds,
    UUID triggerEventId,
    @Nullable UUID triggerFileId,
    String openIdempotencyKey,
    @Nullable UUID previousCaseId,
    @Nullable UUID assigneeUserId,
    @Nullable String pendingDisposition,
    @Nullable OffsetDateTime enrichmentDeadline,
    @Nullable OffsetDateTime resolvedAt,
    int version,
    OffsetDateTime createdAt,
    OffsetDateTime updatedAt) {}
