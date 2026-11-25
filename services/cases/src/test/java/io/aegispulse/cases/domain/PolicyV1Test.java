package io.aegispulse.cases.domain;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

/** FR-CASE-04: policy-v1.0.0 factor combinations (§1.4.5) and its invariants. */
class PolicyV1Test {
  @ParameterizedTest(name = "{0} risk={1} high={2} crit={3} wl={4} flags={5} → {6} {7} {8}")
  @CsvSource({
    "TRANSACTION_RISK, 70, 0, 0, false, 0, 70, CLEARED, HIGH",
    "TRANSACTION_RISK, 75, 0, 0, false, 0, 75, ESCALATED, HIGH",
    "TRANSACTION_RISK, 90, 0, 0, true, 0, 90, ESCALATED, CRITICAL", // watchlist already in the risk
    // score
    "TRANSACTION_RISK, 70, 1, 0, false, 0, 85, ESCALATED, CRITICAL",
    "TRANSACTION_RISK, 70, 3, 0, false, 0, 100, ESCALATED, CRITICAL", // high capped at 30, total at
    // 100
    "DOCUMENT_RISK, , 0, 0, false, 0, 50, CLEARED, MEDIUM",
    "DOCUMENT_RISK, , 0, 0, true, 0, 70, CLEARED, HIGH",
    "DOCUMENT_RISK, , 0, 1, true, 0, 95, ESCALATED, CRITICAL",
    "EXTRACTION_REVIEW, , 0, 0, false, 2, 20, CLEARED, LOW",
    "EXTRACTION_REVIEW, , 0, 0, false, 5, 30, CLEARED, LOW", // clauses capped at 30
    "CORRELATED, , 2, 0, true, 1, 60, CLEARED, MEDIUM",
  })
  void factorCombinations_FR_CASE_04(
      String type,
      Integer risk,
      int high,
      int crit,
      boolean wl,
      int flags,
      int score,
      String outcome,
      String severity) {
    PolicyV1.Result r = PolicyV1.evaluate(new PolicyV1.Inputs(type, risk, high, crit, wl, flags));
    assertThat(r.score()).isEqualTo(score);
    assertThat(r.outcome()).isEqualTo(outcome);
    assertThat(r.severity()).isEqualTo(severity);
    assertThat(r.factors().stream().mapToInt(PolicyV1.Factor::contribution).sum())
        .isGreaterThanOrEqualTo(score);
  }

  @Test
  void invariantsHoldAcrossTheInputSpace_FR_CASE_04() {
    for (String type :
        new String[] {"TRANSACTION_RISK", "DOCUMENT_RISK", "EXTRACTION_REVIEW", "CORRELATED"}) {
      for (int risk = 0; risk <= 100; risk += 5) {
        for (int high = 0; high <= 4; high++) {
          for (int crit = 0; crit <= 2; crit++) {
            for (int flags = 0; flags <= 4; flags++) {
              for (boolean wl : new boolean[] {false, true}) {
                PolicyV1.Result r =
                    PolicyV1.evaluate(new PolicyV1.Inputs(type, risk, high, crit, wl, flags));
                assertThat(r.score()).isBetween(0, 100);
                assertThat(r.outcome()).isEqualTo(r.score() >= 75 ? "ESCALATED" : "CLEARED");
                assertThat(r.severity()).isEqualTo(PolicyV1.band(r.score()));
                // more evidence never lowers the score (monotonic)
                assertThat(
                        PolicyV1.evaluate(
                                new PolicyV1.Inputs(type, risk, high + 1, crit, wl, flags))
                            .score())
                    .isGreaterThanOrEqualTo(r.score());
                assertThat(
                        PolicyV1.evaluate(
                                new PolicyV1.Inputs(type, risk, high, crit + 1, wl, flags))
                            .score())
                    .isGreaterThanOrEqualTo(r.score());
                assertThat(
                        PolicyV1.evaluate(
                                new PolicyV1.Inputs(type, risk, high, crit, wl, flags + 1))
                            .score())
                    .isGreaterThanOrEqualTo(r.score());
              }
            }
          }
        }
      }
    }
  }
}
