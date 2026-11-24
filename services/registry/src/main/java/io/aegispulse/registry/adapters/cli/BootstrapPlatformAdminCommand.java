package io.aegispulse.registry.adapters.cli;

import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.registry.service.PlatformAdminBootstrap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.ExitCodeGenerator;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/**
 * One-shot `bootstrap-platform-admin` (FR-TEN-09): reads PLATFORM_ADMIN_BOOTSTRAP_EMAIL/_PASSWORD
 * (§10.4), calls the one service action and maps the outcome to an exit code. Values are never
 * logged; errors name the variable only.
 */
@Component
@ConditionalOnProperty(name = "aegis.registry.command", havingValue = "bootstrap-platform-admin")
class BootstrapPlatformAdminCommand implements ApplicationRunner, ExitCodeGenerator {
  private static final Logger log = LoggerFactory.getLogger(BootstrapPlatformAdminCommand.class);
  static final String EMAIL = "PLATFORM_ADMIN_BOOTSTRAP_EMAIL";
  static final String PASSWORD = "PLATFORM_ADMIN_BOOTSTRAP_PASSWORD";

  private final PlatformAdminBootstrap bootstrap;
  private final Environment env;
  private int exitCode = 1;

  BootstrapPlatformAdminCommand(PlatformAdminBootstrap bootstrap, Environment env) {
    this.bootstrap = bootstrap;
    this.env = env;
  }

  @Override
  public void run(ApplicationArguments args) {
    String email = env.getProperty(EMAIL, "");
    String password = env.getProperty(PASSWORD, "");
    if (email.isBlank() || password.isEmpty()) {
      log.error("bootstrap.failed reason=missing_config variables={},{}", EMAIL, PASSWORD);
      exitCode = 2;
      return;
    }
    try {
      PlatformAdminBootstrap.Outcome outcome = bootstrap.run(email, password);
      log.info("bootstrap.done outcome={}", outcome);
      exitCode = 0;
    } catch (DomainException e) {
      log.error("bootstrap.failed code={} message={}", e.code(), e.getMessage());
      exitCode = 2;
    }
  }

  @Override
  public int getExitCode() {
    return exitCode;
  }
}
