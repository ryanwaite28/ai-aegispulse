package io.aegispulse.cases.domain;

import java.time.OffsetDateTime;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** One audit log entry as read (FR-AUD-01/03). */
public record AuditEntry(
    UUID id,
    long seq,
    OffsetDateTime occurredAt,
    String actorType,
    String actorId,
    @Nullable String actingAs,
    String action,
    String subjectType,
    String subjectId,
    @Nullable UUID triggerEventId,
    @Nullable UUID triggerFileId,
    @Nullable String modelVersion,
    @Nullable String ruleVersion,
    @Nullable Map<String, @Nullable Object> before,
    @Nullable Map<String, @Nullable Object> after,
    String prevHash,
    String hash) {}
