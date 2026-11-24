package io.aegispulse.registry.config;

import io.aegispulse.platform.config.AegisPlatformProperties;
import io.aegispulse.platform.idempotency.IdempotencyRepository;
import io.aegispulse.platform.security.AegisJwt;
import io.aegispulse.registry.service.SigningKeys;
import java.time.Clock;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.oauth2.jwt.JwtDecoder;

/** registry-owned infrastructure beans (schema `registry`). */
@Configuration
class RegistryConfig {
  @Bean
  IdempotencyRepository idempotencyRepository(JdbcClient jdbc) {
    return new IdempotencyRepository(jdbc, "registry");
  }

  /** Expiry, grace windows and key retirement read this clock (tests substitute a fixed one). */
  @Bean
  @ConditionalOnMissingBean
  Clock clock() {
    return Clock.systemUTC();
  }

  /**
   * The registry verifies tokens against its own published keys in-process (FR-AUTH-05), with the
   * same validators as every other service.
   */
  @Bean
  JwtDecoder registryJwtDecoder(AegisPlatformProperties properties, SigningKeys keys) {
    return AegisJwt.decoder(properties.security(), keys.jwkSource());
  }
}
