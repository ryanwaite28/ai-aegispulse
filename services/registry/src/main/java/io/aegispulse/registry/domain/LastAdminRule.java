package io.aegispulse.registry.domain;

import io.aegispulse.platform.errors.DomainException;
import java.util.Set;

/** FR-TEN-05: a tenant always keeps ≥ 1 ACTIVE user holding TENANT_ADMIN. */
public final class LastAdminRule {
  private LastAdminRule() {}

  /**
   * Rejects a change that would leave no active TENANT_ADMIN.
   *
   * @param otherActiveAdmins ACTIVE TENANT_ADMIN users in the tenant other than the target
   * @param targetActiveAfter whether the target stays ACTIVE after the change
   * @param targetRolesAfter the target's roles after the change
   */
  public static void check(
      int otherActiveAdmins, boolean targetActiveAfter, Set<Role> targetRolesAfter) {
    boolean targetIsAdminAfter = targetActiveAfter && targetRolesAfter.contains(Role.TENANT_ADMIN);
    if (otherActiveAdmins == 0 && !targetIsAdminAfter) {
      throw new DomainException.Conflict(
          "LAST_TENANT_ADMIN", "the tenant must keep at least one active TENANT_ADMIN");
    }
  }
}
