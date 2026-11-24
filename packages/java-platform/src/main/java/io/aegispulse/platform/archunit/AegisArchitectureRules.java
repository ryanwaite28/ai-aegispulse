package io.aegispulse.platform.archunit;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

import com.tngtech.archunit.lang.ArchRule;

/**
 * Layering rules (NFR-04, NFR-09) for Java services. Use from a service test: {@code
 * AegisArchitectureRules.SERVICE_AND_DOMAIN_ARE_TRANSPORT_FREE.check(classes)}.
 */
public final class AegisArchitectureRules {
  private AegisArchitectureRules() {}

  /** No Spring Web / servlet / AMQP / Rabbit client types in service or domain code. */
  public static final ArchRule SERVICE_AND_DOMAIN_ARE_TRANSPORT_FREE =
      noClasses()
          .that()
          .resideInAnyPackage("..service..", "..domain..")
          .should()
          .dependOnClassesThat()
          .resideInAnyPackage(
              "org.springframework.web..",
              "org.springframework.http..",
              "jakarta.servlet..",
              "org.springframework.amqp..",
              "com.rabbitmq..")
          .as("service/domain code is transport-free (NFR-04)");

  /** Domain code is pure: no Spring, JDBC or Jackson. */
  public static final ArchRule DOMAIN_IS_PURE =
      noClasses()
          .that()
          .resideInAPackage("..domain..")
          .should()
          .dependOnClassesThat()
          .resideInAnyPackage(
              "org.springframework..", "java.sql..", "javax.sql..", "tools.jackson..")
          .as("domain code is framework-free (NFR-04)");

  /** Only repositories (..db..) touch JDBC. */
  public static final ArchRule JDBC_ONLY_IN_DB =
      noClasses()
          .that()
          .resideOutsideOfPackages("..db..", "..config..")
          .and()
          .resideInAPackage("io.aegispulse..")
          .and()
          .resideOutsideOfPackage("io.aegispulse.platform..")
          .should()
          .dependOnClassesThat()
          .resideInAnyPackage("org.springframework.jdbc..", "java.sql..", "javax.sql..")
          .as("DB access only through repositories in ..db.. (NFR-09)");

  /** Adapters never reach repositories directly; they call one service action. */
  public static final ArchRule ADAPTERS_CALL_SERVICES_NOT_REPOSITORIES =
      noClasses()
          .that()
          .resideInAPackage("..adapters..")
          .should()
          .dependOnClassesThat()
          .resideInAPackage("..db..")
          .as("adapters call service actions, not repositories (NFR-09)");
}
