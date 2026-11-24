package io.aegispulse.registry.domain;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * FR-AUTH-06 generated table test: for every gateway route backed by a registry action
 * (gateway.public.yaml x-aegis-backing-action), the roles the registry allows equal the route's
 * x-aegis-roles, for every role in §1.4.6.
 */
class AccessPolicyTest {
  static final List<String> ALL_ROLES =
      List.of(
          "PLATFORM_ADMIN",
          "TENANT_ADMIN",
          "ANALYST",
          "VIEWER",
          "COMPLIANCE_AUDITOR",
          "INTEGRATION");

  @SuppressWarnings("unchecked")
  static Map<String, Set<String>> contractRolesByAction() throws IOException {
    Map<String, Object> doc;
    try (InputStream in =
        Files.newInputStream(Path.of("../../packages/contracts/openapi/gateway.public.yaml"))) {
      doc = new Yaml().load(in);
    }
    Map<String, Set<String>> byAction = new HashMap<>();
    Map<String, Object> paths = (Map<String, Object>) doc.get("paths");
    for (Object item : paths.values()) {
      for (Object opValue : ((Map<String, Object>) item).values()) {
        if (!(opValue instanceof Map<?, ?> op) || !op.containsKey("x-aegis-backing-action")) {
          continue;
        }
        List<String> roles = (List<String>) op.get("x-aegis-roles");
        for (String backing : (List<String>) op.get("x-aegis-backing-action")) {
          if (!backing.startsWith("registry.")) {
            continue;
          }
          String action = backing.substring("registry.".length());
          if (AccessPolicy.ROLES.containsKey(action)) {
            byAction.computeIfAbsent(action, k -> new TreeSet<>()).addAll(roles);
          }
        }
      }
    }
    return byAction;
  }

  @Test
  void FR_AUTH_06_everyRegistryRouteTimesEveryRoleMatchesTheContract() throws IOException {
    Map<String, Set<String>> contract = contractRolesByAction();
    // updateTenant (PATCH /v1/tenants/{id}) is backed by two actions: settings (PA, TA) + status
    // (PA).
    Set<String> union = new HashSet<>(AccessPolicy.ROLES.get("updateTenantSettings"));
    union.addAll(AccessPolicy.ROLES.get("updateTenantStatus"));
    assertThat(union).isEqualTo(contract.get("updateTenantSettings"));
    int checked = 0;
    for (Map.Entry<String, Set<String>> e : contract.entrySet()) {
      if (e.getKey().equals("updateTenantSettings") || e.getKey().equals("updateTenantStatus")) {
        continue;
      }
      for (String role : ALL_ROLES) {
        assertThat(AccessPolicy.allows(e.getKey(), List.of(role)))
            .as("%s × %s", e.getKey(), role)
            .isEqualTo(e.getValue().contains(role));
        checked++;
      }
    }
    assertThat(checked).isGreaterThanOrEqualTo(12 * ALL_ROLES.size());
    // Every policy rule is reachable from some public route.
    assertThat(contract.keySet()).containsAll(AccessPolicy.ROLES.keySet());
  }
}
