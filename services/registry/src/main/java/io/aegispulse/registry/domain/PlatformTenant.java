package io.aegispulse.registry.domain;

import java.util.UUID;

/** The reserved tenant that hosts PLATFORM_ADMIN users only (FR-TEN-09). */
public final class PlatformTenant {
  public static final UUID ID = UUID.fromString("00000000-0000-0000-0000-000000000001");
  public static final String SLUG = "platform";

  private PlatformTenant() {}

  public static boolean is(UUID tenantId) {
    return ID.equals(tenantId);
  }
}
