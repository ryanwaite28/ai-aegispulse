package io.aegispulse.registry.domain;

import java.util.Collection;
import java.util.Map;
import java.util.Set;

/**
 * FR-AUTH-06 role matrix for the registry's user-facing actions, kept as data. It mirrors §1.4.6
 * and the {@code x-aegis-roles} of the gateway routes backed by each action (§8.3); {@code
 * AccessPolicyTest} checks the two stay equal. SERVICE callers are governed by their act[]
 * allowlist instead (§5.7.4).
 */
public final class AccessPolicy {
  static final String PA = "PLATFORM_ADMIN";
  static final String TA = "TENANT_ADMIN";
  static final String AN = "ANALYST";
  static final String VI = "VIEWER";
  static final String CA = "COMPLIANCE_AUDITOR";
  static final String IN = "INTEGRATION";

  /** Action → roles allowed to invoke it with a user or integration token. */
  public static final Map<String, Set<String>> ROLES =
      Map.ofEntries(
          Map.entry("createTenant", Set.of(PA)),
          Map.entry("updateTenantStatus", Set.of(PA)),
          Map.entry("getTenantSettings", Set.of(PA, TA)),
          Map.entry("updateTenantSettings", Set.of(PA, TA)),
          Map.entry("createUser", Set.of(PA, TA)),
          Map.entry("listUsers", Set.of(PA, TA)),
          Map.entry("updateUser", Set.of(PA, TA)),
          Map.entry("createServiceAccount", Set.of(TA)),
          Map.entry("listServiceAccounts", Set.of(TA)),
          Map.entry("rotateServiceAccountSecret", Set.of(TA)),
          Map.entry("revokeServiceAccount", Set.of(TA)),
          Map.entry("logout", Set.of(PA, TA, AN, VI, CA, IN)),
          Map.entry("changePassword", Set.of(PA, TA, AN, VI, CA)),
          Map.entry("getCurrentPrincipal", Set.of(PA, TA, AN, VI, CA, IN)),
          Map.entry("listEntities", Set.of(PA, TA, AN, VI)),
          Map.entry("getEntity", Set.of(PA, TA, AN, VI)),
          Map.entry("createEntity", Set.of(PA, TA, AN)),
          Map.entry("updateEntity", Set.of(PA, TA, AN)),
          Map.entry("archiveEntity", Set.of(TA)),
          Map.entry("listWatchlists", Set.of(PA, TA, AN, VI)),
          Map.entry("createWatchlist", Set.of(PA, TA, AN)),
          Map.entry("updateWatchlist", Set.of(PA, TA, AN)),
          Map.entry("deleteWatchlist", Set.of(TA)),
          Map.entry("addWatchlistEntry", Set.of(PA, TA, AN)),
          Map.entry("removeWatchlistEntry", Set.of(PA, TA, AN)));

  private AccessPolicy() {}

  public static boolean allows(String action, Collection<String> roles) {
    Set<String> allowed = ROLES.get(action);
    if (allowed == null) {
      throw new IllegalArgumentException("no access rule for action " + action);
    }
    for (String role : roles) {
      if (allowed.contains(role)) {
        return true;
      }
    }
    return false;
  }
}
