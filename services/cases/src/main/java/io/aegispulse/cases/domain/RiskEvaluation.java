package io.aegispulse.cases.domain;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** A persisted transaction risk evaluation (cases.risk_evaluations, FR-TXN-05). */
public record RiskEvaluation(
    UUID id,
    UUID tenantId,
    String idempotencyKey,
    UUID transactionEventId,
    UUID transactionId,
    String accountId,
    String counterpartyId,
    int score,
    String band,
    List<Map<String, @Nullable Object>> factors,
    String modelVersion,
    String featureVersion,
    List<Map<String, @Nullable Object>> watchlistHits,
    @Nullable UUID caseId,
    @Nullable String suppressedReason,
    OffsetDateTime createdAt) {}
