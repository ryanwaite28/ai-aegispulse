package io.aegispulse.registry.domain;

import java.time.OffsetDateTime;
import java.util.Set;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** A user without credential material (§7.1 registry.users + user_roles; FR-TEN-04/05). */
public record User(
    UUID id,
    UUID tenantId,
    String email,
    String displayName,
    Set<Role> roles,
    UserStatus status,
    boolean mustChangePassword,
    @Nullable OffsetDateTime lastLoginAt,
    OffsetDateTime createdAt,
    OffsetDateTime updatedAt) {}
