package io.aegispulse.platform.config;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import java.net.URI;
import java.time.Duration;
import java.util.List;
import org.jspecify.annotations.Nullable;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

/**
 * Typed platform configuration (PROJECT.md §6.9, §10.4). Services bind env vars in their
 * application.yaml (e.g. {@code aegis.env: ${AEGIS_ENV}}); a missing or invalid value aborts
 * startup with Boot's binding report.
 */
@Validated
@ConfigurationProperties(prefix = "aegis")
public record AegisPlatformProperties(
    @NotBlank String service,
    @NotBlank String version,
    @NotNull Env env,
    @Valid @NotNull Security security,
    @Valid @NotNull Readiness readiness,
    @Valid @NotNull Outbox outbox) {

  /** AEGIS_ENV. */
  public enum Env {
    local,
    dev,
    prod
  }

  /** JWT validation (FR-AUTH-05, §5.7.4). */
  public record Security(
      @NotNull URI jwkSetUri,
      @NotBlank String issuer,
      @NotBlank String audience,
      @DefaultValue("aegispulse-internal") String internalAudience,
      @DefaultValue("60s") Duration clockSkew,
      @DefaultValue List<String> publicPaths) {}

  /** NFR-11 (c): readiness requires the owned schema at or above this Flyway version. */
  public record Readiness(
      @NotBlank @Pattern(regexp = "^[a-z][a-z_]*$") String schema,
      @NotBlank @Pattern(regexp = "^[0-9]+(\\.[0-9]+)*$") String minFlywayVersion) {}

  /** Transactional outbox relay (§6.6). {@code schema} null disables the relay. */
  public record Outbox(
      @Nullable @Pattern(regexp = "^[a-z][a-z_]*$") String schema,
      @DefaultValue("250ms") Duration pollInterval,
      @DefaultValue("100") @Min(1) int batchSize) {}
}
