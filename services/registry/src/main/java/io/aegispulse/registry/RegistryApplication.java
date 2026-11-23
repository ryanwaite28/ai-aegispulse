package io.aegispulse.registry;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * registry composition root (Phase 1e skeleton): java-platform supplies logs, probes, security and
 * messaging.
 */
@SpringBootApplication
public class RegistryApplication {
  public static void main(String[] args) {
    SpringApplication.run(RegistryApplication.class, args);
  }
}
