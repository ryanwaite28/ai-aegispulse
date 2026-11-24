package io.aegispulse.registry.domain;

import java.time.OffsetDateTime;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** A watchlist summary (§7.1 registry.watchlists; FR-ENT-04). */
public record Watchlist(
    UUID id,
    UUID tenantId,
    String name,
    String reason,
    String severityFloor,
    Status status,
    int entryCount,
    @Nullable UUID createdBy,
    OffsetDateTime createdAt,
    OffsetDateTime updatedAt) {

  /** PAUSED watchlists yield no hits (FR-ENT-05). */
  public enum Status {
    ACTIVE,
    PAUSED
  }
}
