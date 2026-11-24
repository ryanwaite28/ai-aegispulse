package io.aegispulse.registry.domain;

import io.aegispulse.platform.errors.DomainException;

/**
 * FR-TEN-02/03 transitions: ACTIVE ↔ SUSPENDED, ACTIVE|SUSPENDED → DEACTIVATED (terminal). Anything
 * else, including a same-status request, is a 409 CONFLICT.
 */
public final class TenantStateMachine {
  /** What a permitted transition means; drives the emitted event. */
  public enum Transition {
    SUSPENDED,
    RESTORED,
    DEACTIVATED
  }

  private TenantStateMachine() {}

  public static Transition transition(TenantStatus from, TenantStatus to) {
    if (from == TenantStatus.ACTIVE && to == TenantStatus.SUSPENDED) {
      return Transition.SUSPENDED;
    }
    if (from == TenantStatus.SUSPENDED && to == TenantStatus.ACTIVE) {
      return Transition.RESTORED;
    }
    if (from != TenantStatus.DEACTIVATED && to == TenantStatus.DEACTIVATED) {
      return Transition.DEACTIVATED;
    }
    throw new DomainException.Conflict(
        "CONFLICT", "tenant status cannot change from " + from + " to " + to);
  }
}
