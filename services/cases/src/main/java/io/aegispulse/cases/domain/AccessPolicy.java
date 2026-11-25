package io.aegispulse.cases.domain;

import java.util.List;
import java.util.Map;

/**
 * Roles per gateway-facing cases action, from the contract role table (gateway.public.yaml
 * x-aegis-roles; the gateway enforces the same table, cases re-checks it, FR-AUTH-06).
 */
public final class AccessPolicy {
  private static final Map<String, List<String>> ROLES =
      Map.ofEntries(
          Map.entry(
              "getTransactionEvaluation",
              List.of("INTEGRATION", "VIEWER", "ANALYST", "TENANT_ADMIN", "PLATFORM_ADMIN")),
          Map.entry("listAuditEntries", List.of("COMPLIANCE_AUDITOR", "TENANT_ADMIN")),
          Map.entry("verifyAuditChain", List.of("COMPLIANCE_AUDITOR")),
          Map.entry("readCases", List.of("VIEWER", "ANALYST", "TENANT_ADMIN", "PLATFORM_ADMIN")),
          Map.entry("workCases", List.of("ANALYST", "TENANT_ADMIN", "PLATFORM_ADMIN")));

  private AccessPolicy() {}

  public static boolean allows(String action, List<String> roles) {
    List<String> allowed = ROLES.getOrDefault(action, List.of());
    return roles.stream().anyMatch(allowed::contains);
  }
}
