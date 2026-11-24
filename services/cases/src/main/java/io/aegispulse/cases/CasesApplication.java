package io.aegispulse.cases;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * cases composition root (Phase 1e skeleton): java-platform supplies logs, probes, security and
 * messaging.
 */
@SpringBootApplication
public class CasesApplication {
  public static void main(String[] args) {
    SpringApplication.run(CasesApplication.class, args);
  }
}
