package io.aegispulse.cases.domain;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * Case policy evaluation {@code policy-v1.0.0} (PROJECT.md §1.4.5). Pure: evidence facts in, score,
 * outcome, severity and the factor breakdown out.
 *
 * <pre>
 * policy_score = base_score            (risk score for TRANSACTION_RISK; 50 for DOCUMENT_RISK; 0 otherwise)
 *              + min(30, 15 × correlated evidence with final_severity HIGH)
 *              + 25 if any correlated evidence has final_severity CRITICAL
 *              + 20 if watchlist hit and not already counted in base_score
 *              + min(30, 10 × extraction red-flag clauses)
 * policy_score = min(100, policy_score); outcome = ESCALATED if ≥ 75 else CLEARED; severity = band(score)
 * </pre>
 *
 * "Already counted in base_score": a TRANSACTION_RISK base score includes the §1.4.4 watchlist
 * factor whenever the counterparty was on a watchlist, so the bonus applies to other case types
 * only.
 */
public final class PolicyV1 {
  public static final String VERSION = "policy-v1.0.0";
  public static final int ESCALATION_THRESHOLD = 75;

  private PolicyV1() {}

  /** The evidence facts the policy reads. */
  public record Inputs(
      String caseType,
      @Nullable Integer riskScore,
      int correlatedHigh,
      int correlatedCritical,
      boolean watchlistHit,
      int redFlagClauses) {}

  public record Factor(String name, int value, int contribution) {}

  public record Result(int score, String outcome, String severity, List<Factor> factors) {
    public Map<String, Object> factorsAsJson() {
      Map<String, Object> m = new LinkedHashMap<>();
      for (Factor f : factors) {
        m.put(f.name(), Map.of("value", f.value(), "contribution", f.contribution()));
      }
      return m;
    }
  }

  public static Result evaluate(Inputs in) {
    List<Factor> factors = new ArrayList<>();
    int base =
        switch (in.caseType()) {
          case "TRANSACTION_RISK" -> in.riskScore() == null ? 0 : in.riskScore();
          case "DOCUMENT_RISK" -> 50;
          default -> 0;
        };
    factors.add(new Factor("base_score", base, base));
    int high = Math.min(30, 15 * in.correlatedHigh());
    factors.add(new Factor("correlated_high", in.correlatedHigh(), high));
    int critical = in.correlatedCritical() > 0 ? 25 : 0;
    factors.add(new Factor("correlated_critical", in.correlatedCritical(), critical));
    boolean watchlistCounted = "TRANSACTION_RISK".equals(in.caseType());
    int watchlist = in.watchlistHit() && !watchlistCounted ? 20 : 0;
    factors.add(new Factor("watchlist", in.watchlistHit() ? 1 : 0, watchlist));
    int clauses = Math.min(30, 10 * in.redFlagClauses());
    factors.add(new Factor("red_flag_clauses", in.redFlagClauses(), clauses));
    int score = Math.min(100, base + high + critical + watchlist + clauses);
    return new Result(
        score,
        score >= ESCALATION_THRESHOLD ? "ESCALATED" : "CLEARED",
        band(score),
        List.copyOf(factors));
  }

  /** §1.4.4 bands. */
  public static String band(int score) {
    if (score >= 85) {
      return "CRITICAL";
    }
    if (score >= 70) {
      return "HIGH";
    }
    if (score >= 40) {
      return "MEDIUM";
    }
    return "LOW";
  }
}
