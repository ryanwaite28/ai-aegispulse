package io.aegispulse.cases.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.aegispulse.platform.errors.DomainException;
import java.util.EnumSet;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** FR-CASE-02: the exhaustive transition matrix (every from × to pair). */
class CaseStateMachineTest {
  private static final Map<CaseStatus, Set<CaseStatus>> EXPECTED =
      Map.of(
          CaseStatus.OPEN, EnumSet.of(CaseStatus.ENRICHING),
          CaseStatus.ENRICHING, EnumSet.of(CaseStatus.POLICY_EVALUATED),
          CaseStatus.POLICY_EVALUATED, EnumSet.of(CaseStatus.ESCALATED, CaseStatus.CLEARED),
          CaseStatus.ESCALATED, EnumSet.of(CaseStatus.ENRICHING, CaseStatus.RESOLVED),
          CaseStatus.CLEARED, EnumSet.of(CaseStatus.ENRICHING, CaseStatus.RESOLVED),
          CaseStatus.RESOLVED, EnumSet.noneOf(CaseStatus.class));

  @Test
  void exhaustiveTransitionMatrix_FR_CASE_02() {
    int checked = 0;
    for (CaseStatus from : CaseStatus.values()) {
      for (CaseStatus to : CaseStatus.values()) {
        boolean expected = EXPECTED.get(from).contains(to);
        assertThat(CaseStateMachine.allows(from, to)).as(from + " → " + to).isEqualTo(expected);
        if (!expected) {
          assertThatThrownBy(() -> CaseStateMachine.require(from, to))
              .isInstanceOfSatisfying(
                  DomainException.class,
                  e -> assertThat(e.code()).isEqualTo("CASE_INVALID_TRANSITION"));
        }
        checked++;
      }
    }
    assertThat(checked).isEqualTo(36);
  }

  @Test
  void caseNumbersArePerYearSixDigits_FR_CASE_01() {
    assertThat(CaseNumbers.format(2026, 1)).isEqualTo("AP-2026-000001");
    assertThat(CaseNumbers.format(2026, 999_999)).isEqualTo("AP-2026-999999");
    assertThatThrownBy(() -> CaseNumbers.format(2026, 1_000_000))
        .isInstanceOf(IllegalArgumentException.class);
  }
}
