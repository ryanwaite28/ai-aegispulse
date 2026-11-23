package io.aegispulse.platform.archunit;

import static org.assertj.core.api.Assertions.assertThat;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import org.junit.jupiter.api.Test;

/** NFR-04 rules catch a leaking service and accept a clean one. */
class AegisArchitectureRulesTest {
  private final JavaClasses bad =
      new ClassFileImporter().importPackages("io.aegispulse.fixture.bad");
  private final JavaClasses good =
      new ClassFileImporter().importPackages("io.aegispulse.fixture.good");

  @Test
  void transportTypesInServiceCodeFail() {
    assertThat(
            AegisArchitectureRules.SERVICE_AND_DOMAIN_ARE_TRANSPORT_FREE
                .evaluate(bad)
                .hasViolation())
        .isTrue();
    assertThat(
            AegisArchitectureRules.SERVICE_AND_DOMAIN_ARE_TRANSPORT_FREE
                .evaluate(good)
                .hasViolation())
        .isFalse();
  }

  @Test
  void jdbcConfinedToRepositories() {
    assertThat(AegisArchitectureRules.JDBC_ONLY_IN_DB.evaluate(good).hasViolation()).isFalse();
  }
}
