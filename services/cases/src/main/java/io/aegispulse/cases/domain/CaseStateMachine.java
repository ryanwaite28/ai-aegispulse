package io.aegispulse.cases.domain;

import io.aegispulse.platform.errors.DomainException;
import java.util.EnumMap;
import java.util.EnumSet;
import java.util.Map;
import java.util.Set;

/**
 * The FR-CASE-02 transition table. Pure; anything outside it is {@code 409
 * CASE_INVALID_TRANSITION}. RESOLVED is terminal.
 */
public final class CaseStateMachine {
  private static final Map<CaseStatus, Set<CaseStatus>> ALLOWED = new EnumMap<>(CaseStatus.class);

  static {
    ALLOWED.put(CaseStatus.OPEN, EnumSet.of(CaseStatus.ENRICHING));
    ALLOWED.put(CaseStatus.ENRICHING, EnumSet.of(CaseStatus.POLICY_EVALUATED));
    ALLOWED.put(CaseStatus.POLICY_EVALUATED, EnumSet.of(CaseStatus.ESCALATED, CaseStatus.CLEARED));
    ALLOWED.put(CaseStatus.ESCALATED, EnumSet.of(CaseStatus.ENRICHING, CaseStatus.RESOLVED));
    ALLOWED.put(CaseStatus.CLEARED, EnumSet.of(CaseStatus.ENRICHING, CaseStatus.RESOLVED));
    ALLOWED.put(CaseStatus.RESOLVED, EnumSet.noneOf(CaseStatus.class));
  }

  private CaseStateMachine() {}

  public static boolean allows(CaseStatus from, CaseStatus to) {
    Set<CaseStatus> next = ALLOWED.get(from);
    return next != null && next.contains(to);
  }

  public static void require(CaseStatus from, CaseStatus to) {
    if (!allows(from, to)) {
      throw new DomainException.Conflict(
          "CASE_INVALID_TRANSITION", "transition " + from + " → " + to + " is not allowed");
    }
  }
}
