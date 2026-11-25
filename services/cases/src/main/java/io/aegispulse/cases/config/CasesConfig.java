package io.aegispulse.cases.config;

import java.time.Clock;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** cases wiring. No business logic. */
@Configuration
class CasesConfig {
  @Bean
  Clock clock() {
    return Clock.systemUTC();
  }
}
