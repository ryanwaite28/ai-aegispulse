package io.aegispulse.registry.domain;

import java.time.OffsetDateTime;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** A watchlist entry (§7.1 registry.watchlist_entries; FR-ENT-04). */
public record WatchlistEntry(
    UUID watchlistId,
    UUID entityId,
    @Nullable String note,
    @Nullable UUID addedBy,
    OffsetDateTime createdAt) {}
