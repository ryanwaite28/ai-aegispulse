package io.aegispulse.registry.service;

import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.platform.security.AegisPrincipal;
import io.aegispulse.registry.domain.AccessPolicy;
import io.aegispulse.registry.domain.PlatformTenant;
import io.aegispulse.registry.domain.Role;
import java.util.List;
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

  /** FR-AUTH-06: the caller's roles must be allowed for {@code action} (AccessPolicy). */
  static void requireRole(String action, List<String> roles) {
    if (!AccessPolicy.allows(action, roles)) {
      throw new DomainException.Forbidden("FORBIDDEN", "role not allowed for " + action);
    }
  }

  static UUID uuid(String value) {
    return UUID.fromString(value);
  }

  /**
   * Resolves the effective tenant for a tenant-scoped action: own tenant for tenant roles, or the
   * X-Aegis-Tenant target for PLATFORM_ADMIN (§6.2). Existence is checked by the caller (404).
   */
  static TenantAccess forTenantAction(
      String action, AegisPrincipal principal, @Nullable UUID actingTenant) {
    AegisPrincipal.User user = requireUser(principal);
    requireRole(action, user.roles());
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
    return new TenantAccess(uuid(user.tenantId()), actor, false);
  }
}
