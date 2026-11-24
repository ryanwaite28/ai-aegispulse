package io.aegispulse.registry.adapters.http;

import io.aegispulse.registry.domain.Tenant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** Contract `Tenant` shape: the threshold is a decimal string, never a JSON number. */
record TenantView(
    UUID id,
    String slug,
    String displayName,
    String status,
    @Nullable String statusReason,
    String highValueThresholdUsd,
    List<String> highRiskCountries,
    int retentionDays,
    boolean demoMode,
    OffsetDateTime createdAt,
    OffsetDateTime updatedAt) {

  static TenantView of(Tenant t) {
    return new TenantView(
        t.id(),
        t.slug(),
        t.displayName(),
        t.status().name(),
        t.statusReason(),
        t.highValueThresholdUsd().stripTrailingZeros().toPlainString(),
        t.highRiskCountries(),
        t.retentionDays(),
        t.demoMode(),
        t.createdAt(),
        t.updatedAt());
  }
}
