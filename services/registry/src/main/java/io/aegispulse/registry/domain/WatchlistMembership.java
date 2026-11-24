package io.aegispulse.registry.domain;

import java.util.UUID;

/** A non-deleted watchlist that contains an entity (entity detail, FR-ENT-02). */
public record WatchlistMembership(UUID id, String name, Watchlist.Status status) {}
