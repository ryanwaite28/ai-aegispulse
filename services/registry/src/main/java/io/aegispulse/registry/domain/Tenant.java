package io.aegispulse.registry.domain;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** A tenant with its settings (§7.1 registry.tenants; FR-TEN-01, FR-TEN-08). */
public record Tenant(
    UUID id,
    String slug,
    String displayName,
    TenantStatus status,
    @Nullable String statusReason,
    BigDecimal highValueThresholdUsd,
    List<String> highRiskCountries,
    int retentionDays,
    boolean demoMode,
    OffsetDateTime createdAt,
    OffsetDateTime updatedAt) {}
