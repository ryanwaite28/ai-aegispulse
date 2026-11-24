package io.aegispulse.registry.adapters.http;

import io.aegispulse.platform.errors.DomainException;
import java.util.List;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** Transport parsing of the §6.2 headers. */
final class Headers {
  static final String IDEMPOTENCY_KEY = "Idempotency-Key";
  static final String ACTING_TENANT = "X-Aegis-Tenant";

  private Headers() {}

  static @Nullable UUID actingTenant(@Nullable String raw) {
    if (raw == null || raw.isBlank()) {
      return null;
    }
    try {
      return UUID.fromString(raw.strip());
    } catch (IllegalArgumentException e) {
      throw new DomainException.Validation(
          "VALIDATION_ERROR",
          "request failed validation",
          List.of(new DomainException.ErrorDetail(ACTING_TENANT, "must be a UUID")));
    }
  }
}
