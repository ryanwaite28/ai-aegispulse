package io.aegispulse.cases.domain;

/** Case lifecycle states (FR-CASE-02). */
public enum CaseStatus {
  OPEN,
  ENRICHING,
  POLICY_EVALUATED,
  ESCALATED,
  CLEARED,
  RESOLVED
}
