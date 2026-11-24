package io.aegispulse.registry.domain;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.aegispulse.platform.errors.DomainException;
import java.util.List;
import org.junit.jupiter.api.Test;

class PasswordPolicyTest {
  private static final List<String> INPUTS = List.of("alice", "Alice Analyst", "acme-capital");

  @Test
  void FR_TEN_04_rejectsShortPasswords() {
    assertPolicyViolation("Xk9#mQ2$vL7!"); // 12 chars, strong but short
  }

  @Test
  void FR_TEN_04_rejectsOverlongPasswords() {
    assertPolicyViolation("aB3$".repeat(65));
  }

  @Test
  void FR_TEN_04_rejectsGuessablePasswordsEvenWhenLong() {
    assertPolicyViolation("password123456");
    assertPolicyViolation("aaaaaaaaaaaaaaaa");
  }

  @Test
  void FR_TEN_04_penalizesTheUsersOwnIdentifiers() {
    assertPolicyViolation("acme-capital-alice");
  }

  @Test
  void FR_TEN_04_acceptsStrongPasswords() {
    assertThatCode(() -> PasswordPolicy.check("violet-Harbor-71-quartz!", INPUTS))
        .doesNotThrowAnyException();
    assertThatCode(() -> PasswordPolicy.check("Aa1-" + "3f9c2b7e1d04a8c6f5e2", INPUTS))
        .doesNotThrowAnyException(); // the generated bootstrap/local format
  }

  private static void assertPolicyViolation(String password) {
    assertThatThrownBy(() -> PasswordPolicy.check(password, INPUTS))
        .isInstanceOf(DomainException.Validation.class)
        .extracting(e -> ((DomainException) e).code())
        .isEqualTo("AUTH_PASSWORD_POLICY");
  }
}
