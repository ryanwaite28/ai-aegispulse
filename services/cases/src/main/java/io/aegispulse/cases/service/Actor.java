package io.aegispulse.cases.service;

import io.aegispulse.platform.security.AegisPrincipal;
import org.jspecify.annotations.Nullable;

/**
 * Who caused a change, as recorded in transitions and the audit log (FR-AUD-01 actorType/actorId).
 */
public record Actor(String type, String id, @Nullable String actingAs) {
  public static final Actor SYSTEM = new Actor("SYSTEM", "cases", null);

  public static Actor of(AegisPrincipal principal) {
    return switch (principal) {
      case AegisPrincipal.User u -> new Actor("USER", u.userId(), null);
      case AegisPrincipal.Integration i ->
          new Actor("SERVICE", "integration:" + i.clientId(), null);
      case AegisPrincipal.Service s -> new Actor("SERVICE", s.clientId(), null);
    };
  }

  /** case_transitions.trigger_type for this actor. */
  String triggerType() {
    return "USER".equals(type) ? "USER" : "SYSTEM".equals(type) ? "SYSTEM" : "EVENT";
  }
}
