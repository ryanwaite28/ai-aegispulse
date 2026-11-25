package io.aegispulse.cases.domain;

import java.time.OffsetDateTime;
import org.jspecify.annotations.Nullable;

/** FR-AUD-03 list filters (all optional). */
public record AuditFilter(
    @Nullable String subjectType,
    @Nullable String subjectId,
    @Nullable String actorId,
    @Nullable String action,
    @Nullable OffsetDateTime from,
    @Nullable OffsetDateTime to) {}
