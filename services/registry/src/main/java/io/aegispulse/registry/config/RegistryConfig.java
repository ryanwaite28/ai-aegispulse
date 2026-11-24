package io.aegispulse.registry.config;

import io.aegispulse.platform.idempotency.IdempotencyRepository;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.simple.JdbcClient;

/** registry-owned infrastructure beans (schema `registry`). */
@Configuration
class RegistryConfig {
  @Bean
  IdempotencyRepository idempotencyRepository(JdbcClient jdbc) {
    return new IdempotencyRepository(jdbc, "registry");
  }
}
