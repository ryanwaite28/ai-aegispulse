package io.aegispulse.registry.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.registry.domain.TenantStateMachine.Transition;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

class TenantStateMachineTest {
  @ParameterizedTest(name = "FR_TEN_02_03 {0} -> {1} = {2}")
  @CsvSource({
    "ACTIVE, SUSPENDED, SUSPENDED",
    "SUSPENDED, ACTIVE, RESTORED",
    "ACTIVE, DEACTIVATED, DEACTIVATED",
    "SUSPENDED, DEACTIVATED, DEACTIVATED"
  })
  void FR_TEN_02_03_allowedTransitions(TenantStatus from, TenantStatus to, Transition expected) {
    assertThat(TenantStateMachine.transition(from, to)).isEqualTo(expected);
  }

  @ParameterizedTest(name = "FR_TEN_02_03 {0} -> {1} is a conflict")
  @CsvSource({
    "ACTIVE, ACTIVE",
    "SUSPENDED, SUSPENDED",
    "DEACTIVATED, DEACTIVATED",
    "DEACTIVATED, ACTIVE",
    "DEACTIVATED, SUSPENDED"
  })
  void FR_TEN_02_03_rejectedTransitions(TenantStatus from, TenantStatus to) {
    assertThatThrownBy(() -> TenantStateMachine.transition(from, to))
        .isInstanceOf(DomainException.Conflict.class)
        .extracting(e -> ((DomainException) e).code())
        .isEqualTo("CONFLICT");
  }
}
