package io.aegispulse.platform.security;

import io.aegispulse.platform.errors.DomainException;
import org.jspecify.annotations.Nullable;
import org.springframework.security.core.Authentication;

/**
 * §6.2 / §5.7.4: every internal route requires a user token (RBAC and tenant checks stay in the
 * service layer) or a SERVICE token whose act[] contains the invoked action, e.g. {@code
 * requireAction(auth, "cases.recordRiskEvaluation")}.
 */
public final class ServiceActionAuthorizer {

  public AegisPrincipal requireAction(@Nullable Authentication authentication, String action) {
    if (!(authentication instanceof AegisAuthentication auth)) {
      throw new DomainException.Unauthorized("UNAUTHORIZED", "authentication required");
    }
    AegisPrincipal principal = auth.getPrincipal();
    if (principal instanceof AegisPrincipal.Service service
        && !service.actions().contains(action)) {
      throw new DomainException.Forbidden(
          "FORBIDDEN", "service " + service.clientId() + " may not call " + action);
    }
    return principal;
  }
}
