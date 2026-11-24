package io.aegispulse.registry.domain;

import java.time.OffsetDateTime;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** A service account summary without secret material (§7.1; FR-TEN-06/07). */
public record ServiceAccount(
    UUID id,
    @Nullable UUID tenantId,
    String clientId,
    String name,
    Kind kind,
    Status status,
    OffsetDateTime createdAt,
    OffsetDateTime updatedAt) {

  /** INTEGRATION (tenant, created by TENANT_ADMIN) or SERVICE (internal runtime, seeded). */
  public enum Kind {
    INTEGRATION,
    SERVICE
  }

  /** Revoked accounts can no longer obtain tokens. */
  public enum Status {
    ACTIVE,
    REVOKED
  }
}
