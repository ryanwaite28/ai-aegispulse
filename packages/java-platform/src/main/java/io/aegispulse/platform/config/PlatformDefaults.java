package io.aegispulse.platform.config;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.EnvironmentPostProcessor;
import org.springframework.boot.SpringApplication;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

/**
 * Platform defaults with the lowest precedence (a service may override any of them in its own
 * configuration): structured JSON logs (NFR-07), graceful shutdown and probes on /livez /readyz
 * /healthz (NFR-11), virtual threads (§6.3), publisher confirms + returns + mandatory, manual ack,
 * passive queue checks only and no runtime declaration (§6.5).
 */
public final class PlatformDefaults implements EnvironmentPostProcessor {

  static final String SOURCE_NAME = "aegisPlatformDefaults";

  static Map<String, Object> defaults() {
    Map<String, Object> d = new LinkedHashMap<>();
    d.put("logging.structured.format.console", "io.aegispulse.platform.logging.AegisJsonFormatter");
    d.put("spring.main.banner-mode", "off");
    d.put("spring.threads.virtual.enabled", "true");
    d.put("server.shutdown", "graceful");
    d.put("spring.lifecycle.timeout-per-shutdown-phase", "20s");
    d.put("server.max-http-request-header-size", "16KB");
    // Health: liveness never checks dependencies; readiness gates on db, broker and schema version.
    d.put("management.endpoints.web.exposure.include", "health");
    d.put("management.endpoint.health.probes.enabled", "true");
    d.put("management.endpoint.health.group.liveness.include", "livenessState");
    d.put("management.endpoint.health.group.liveness.additional-path", "server:/livez");
    d.put(
        "management.endpoint.health.group.readiness.include",
        "readinessState,db,rabbit,flywaySchema");
    d.put("management.endpoint.health.group.readiness.additional-path", "server:/readyz");
    d.put("management.endpoint.health.group.healthz.include", "*");
    d.put("management.endpoint.health.group.healthz.additional-path", "server:/healthz");
    d.put("management.endpoint.health.group.healthz.show-components", "always");
    d.put("management.endpoint.health.group.healthz.show-details", "never");
    // RabbitMQ (§6.5): confirms, returns, mandatory; manual ack; never declare at runtime.
    d.put("spring.rabbitmq.publisher-confirm-type", "correlated");
    d.put("spring.rabbitmq.publisher-returns", "true");
    d.put("spring.rabbitmq.template.mandatory", "true");
    d.put("spring.rabbitmq.dynamic", "false");
    d.put("spring.rabbitmq.listener.simple.acknowledge-mode", "manual");
    d.put("spring.rabbitmq.listener.simple.missing-queues-fatal", "true");
    d.put("spring.rabbitmq.listener.simple.default-requeue-rejected", "true");
    return d;
  }

  @Override
  public void postProcessEnvironment(
      ConfigurableEnvironment environment, SpringApplication application) {
    environment.getPropertySources().addLast(new MapPropertySource(SOURCE_NAME, defaults()));
  }
}
