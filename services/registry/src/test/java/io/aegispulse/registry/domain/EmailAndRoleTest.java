package io.aegispulse.registry.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.aegispulse.platform.errors.DomainException;
import java.util.List;
import org.junit.jupiter.api.Test;

class EmailAndRoleTest {
  @Test
  void FR_TEN_04_emailIsTrimmedAndLowerCased() {
    assertThat(EmailAddress.parse("  Alice.Analyst@Acme.Example ").value())
        .isEqualTo("alice.analyst@acme.example");
  }

  @Test
  void FR_TEN_04_rejectsInvalidEmails() {
    for (String bad : List.of("no-at-sign", "a@b", "two@@acme.example", "a b@acme.example")) {
      assertThatThrownBy(() -> EmailAddress.parse(bad))
          .isInstanceOf(DomainException.Validation.class);
    }
  }

  @Test
  void FR_TEN_04_rolesAreANonEmptySetOfTenantRoles() {
    assertThat(Role.tenantRoles(List.of("ANALYST", "analyst", "VIEWER")))
        .containsExactlyInAnyOrder(Role.ANALYST, Role.VIEWER);
    assertThatThrownBy(() -> Role.tenantRoles(List.of()))
        .isInstanceOf(DomainException.Validation.class);
    assertThatThrownBy(() -> Role.tenantRoles(List.of("PLATFORM_ADMIN")))
        .isInstanceOf(DomainException.Validation.class);
    assertThatThrownBy(() -> Role.tenantRoles(List.of("ROOT")))
        .isInstanceOf(DomainException.Validation.class);
  }
}
