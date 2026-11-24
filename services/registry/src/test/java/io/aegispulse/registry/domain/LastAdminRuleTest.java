package io.aegispulse.registry.domain;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.aegispulse.platform.errors.DomainException;
import java.util.EnumSet;
import org.junit.jupiter.api.Test;

class LastAdminRuleTest {
  @Test
  void FR_TEN_05_lastAdminCannotDropTheRole() {
    assertThatThrownBy(() -> LastAdminRule.check(0, true, EnumSet.of(Role.ANALYST)))
        .isInstanceOf(DomainException.Conflict.class)
        .extracting(e -> ((DomainException) e).code())
        .isEqualTo("LAST_TENANT_ADMIN");
  }

  @Test
  void FR_TEN_05_lastAdminCannotBeDisabled() {
    assertThatThrownBy(() -> LastAdminRule.check(0, false, EnumSet.of(Role.TENANT_ADMIN)))
        .isInstanceOf(DomainException.Conflict.class);
  }

  @Test
  void FR_TEN_05_allowedWhenAnotherAdminRemainsOrTargetStaysAdmin() {
    assertThatCode(() -> LastAdminRule.check(1, false, EnumSet.of(Role.VIEWER)))
        .doesNotThrowAnyException();
    assertThatCode(() -> LastAdminRule.check(0, true, EnumSet.of(Role.TENANT_ADMIN, Role.ANALYST)))
        .doesNotThrowAnyException();
  }
}
