package io.aegispulse.platform.config;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.core.env.MapPropertySource;
import org.springframework.mock.env.MockEnvironment;

class PlatformDefaultsTest {
  @Test
  void addsLowestPrecedenceDefaultsForMessagingHealthAndLogging_NFR_11() {
    MockEnvironment env =
        new MockEnvironment().withProperty("spring.rabbitmq.template.mandatory", "false");
    new PlatformDefaults()
        .postProcessEnvironment(env, new org.springframework.boot.SpringApplication());
    assertThat(env.getProperty("spring.rabbitmq.publisher-confirm-type")).isEqualTo("correlated");
    assertThat(env.getProperty("spring.rabbitmq.dynamic"))
        .isEqualTo("false"); // never declare at runtime
    assertThat(env.getProperty("management.endpoint.health.group.liveness.additional-path"))
        .isEqualTo("server:/livez");
    assertThat(env.getProperty("management.endpoint.health.group.readiness.include"))
        .contains("flywaySchema");
    // a service override wins over the platform default
    assertThat(env.getProperty("spring.rabbitmq.template.mandatory")).isEqualTo("false");
    assertThat(env.getPropertySources().get(PlatformDefaults.SOURCE_NAME))
        .isInstanceOf(MapPropertySource.class);
  }
}
