package io.aegispulse.cases;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import io.aegispulse.platform.archunit.AegisArchitectureRules;
import org.junit.jupiter.api.Test;

/**
 * NFR-04 / NFR-09 layering rules applied to cases from day one (they bite as FRs add service/domain
 * code).
 */
class ArchitectureTest {
  private final JavaClasses classes =
      new ClassFileImporter()
          .withImportOption(ImportOption.Predefined.DO_NOT_INCLUDE_TESTS)
          .importPackages("io.aegispulse.cases");

  @Test
  void layeringRules() {
    AegisArchitectureRules.SERVICE_AND_DOMAIN_ARE_TRANSPORT_FREE
        .allowEmptyShould(true)
        .check(classes);
    AegisArchitectureRules.DOMAIN_IS_PURE.allowEmptyShould(true).check(classes);
    AegisArchitectureRules.JDBC_ONLY_IN_DB.allowEmptyShould(true).check(classes);
    AegisArchitectureRules.ADAPTERS_CALL_SERVICES_NOT_REPOSITORIES
        .allowEmptyShould(true)
        .check(classes);
  }
}
