package io.aegispulse.registry.service;

import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.platform.security.AegisPrincipal;
import io.aegispulse.registry.domain.PlatformTenant;
import io.aegispulse.registry.domain.Role;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * Who is acting and on which tenant (FR-AUTH-06, §6.2): a TENANT_ADMIN on its own tenant, or a
 * PLATFORM_ADMIN on the tenant named by X-Aegis-Tenant ({@code actingAsPlatformAdmin}).
 */
public record TenantAccess(UUID tenantId, UUID actorId, boolean actingAsPlatformAdmin) {

  /** The authenticated human user; SERVICE and INTEGRATION principals are refused. */
  static AegisPrincipal.User requireUser(AegisPrincipal principal) {
    if (principal instanceof AegisPrincipal.User user) {
      return user;
    }
    throw new DomainException.Forbidden("FORBIDDEN", "this action requires a user token");
  }

  static void requirePlatformAdmin(AegisPrincipal.User user) {
    if (!user.hasAnyRole(Role.PLATFORM_ADMIN.name())) {
      throw new DomainException.Forbidden("FORBIDDEN", "PLATFORM_ADMIN role required");
    }
  }

  static UUID uuid(String value) {
    return UUID.fromString(value);
  }

  /**
   * Resolves the effective tenant for a TENANT_ADMIN-level action. Existence of the acting tenant
   * is checked by the caller (unknown → 404).
   */
  static TenantAccess forTenantAdminAction(AegisPrincipal principal, @Nullable UUID actingTenant) {
    AegisPrincipal.User user = requireUser(principal);
    UUID actor = uuid(user.userId());
    if (user.hasAnyRole(Role.PLATFORM_ADMIN.name())) {
      if (actingTenant == null) {
        throw new DomainException.Forbidden(
            "FORBIDDEN", "PLATFORM_ADMIN must name the tenant with X-Aegis-Tenant");
      }
      if (PlatformTenant.is(actingTenant)) {
        throw new DomainException.NotFound("NOT_FOUND", "tenant not found");
      }
      return new TenantAccess(actingTenant, actor, true);
    }
    if (actingTenant != null) {
      throw new DomainException.Forbidden("FORBIDDEN", "X-Aegis-Tenant is for PLATFORM_ADMIN only");
    }
    if (!user.hasAnyRole(Role.TENANT_ADMIN.name())) {
      throw new DomainException.Forbidden("FORBIDDEN", "TENANT_ADMIN role required");
    }
    return new TenantAccess(uuid(user.tenantId()), actor, false);
  }
}
