package io.aegispulse.registry.domain;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** A tracked entity (§7.1 registry.entities + aliases; FR-ENT-01/02). */
public record Entity(
    UUID id,
    UUID tenantId,
    String name,
    String normalizedName,
    Type entityType,
    @Nullable String ticker,
    @Nullable String lei,
    @Nullable String country,
    List<String> aliases,
    @Nullable OffsetDateTime archivedAt,
    OffsetDateTime createdAt,
    OffsetDateTime updatedAt) {

  /** registry.entities.entity_type. */
  public enum Type {
    ORGANIZATION,
    TICKER,
    COUNTERPARTY,
    AGENCY,
    PERSON
  }

  /** FR-ENT-03 match kinds, in resolution order. */
  public enum MatchType {
    TICKER_EXACT,
    ALIAS_EXACT,
    NAME_NORMALIZED,
    TRIGRAM
  }
}
