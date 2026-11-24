package io.aegispulse.registry.domain;

import io.aegispulse.platform.errors.DomainException;
import java.util.Collection;
import java.util.EnumSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * §1.4.6 user roles. PLATFORM_ADMIN is global (platform tenant only); the rest are tenant roles.
 */
public enum Role {
  PLATFORM_ADMIN,
  TENANT_ADMIN,
  ANALYST,
  VIEWER,
  COMPLIANCE_AUDITOR;

  public static final Set<Role> TENANT_ROLES =
      EnumSet.of(TENANT_ADMIN, ANALYST, VIEWER, COMPLIANCE_AUDITOR);

  /** Parses a non-empty set of tenant roles (FR-TEN-04); PLATFORM_ADMIN is never assignable. */
  public static Set<Role> tenantRoles(Collection<String> names) {
    if (names.isEmpty()) {
      throw invalid("at least one role is required");
    }
    EnumSet<Role> roles = EnumSet.noneOf(Role.class);
    for (String name : names) {
      Role role;
      try {
        role = Role.valueOf(name.toUpperCase(Locale.ROOT));
      } catch (IllegalArgumentException e) {
        throw invalid("unknown role " + name);
      }
      if (!TENANT_ROLES.contains(role)) {
        throw invalid("role " + role + " is not a tenant role");
      }
      roles.add(role);
    }
    return roles;
  }

  private static DomainException invalid(String issue) {
    return new DomainException.Validation(
        "VALIDATION_ERROR",
        "request failed validation",
        List.of(new DomainException.ErrorDetail("roles", issue)));
  }
}
