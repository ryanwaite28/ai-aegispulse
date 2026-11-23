package io.aegispulse.platform.security;

import java.util.List;

/**
 * Authenticated caller (§2.2, §5.7.4): a user (forwarded user JWT) or a SERVICE account with an
 * act[] allowlist.
 */
public sealed interface AegisPrincipal
    permits AegisPrincipal.User, AegisPrincipal.Integration, AegisPrincipal.Service {

  /** Subject id used in audit records. */
  String subject();

  /** typ=user, aud=JWT_AUDIENCE. */
  record User(String userId, String tenantId, String tenantSlug, List<String> roles, String tokenId)
      implements AegisPrincipal {
    @Override
    public String subject() {
      return userId;
    }

    public boolean hasAnyRole(String... wanted) {
      for (String role : wanted) {
        if (roles.contains(role)) {
          return true;
        }
      }
      return false;
    }
  }

  /** typ=integration: INTEGRATION service account (FR-TEN-06, FR-AUTH-04), tenant-scoped. */
  record Integration(
      String clientId, String tenantId, String tenantSlug, List<String> roles, String tokenId)
      implements AegisPrincipal {
    @Override
    public String subject() {
      return clientId;
    }
  }

  /**
   * aud=aegispulse-internal; {@code actions} is the act[] claim, e.g. "registry.resolveEntities".
   */
  record Service(String clientId, List<String> actions) implements AegisPrincipal {
    @Override
    public String subject() {
      return clientId;
    }
  }
}
