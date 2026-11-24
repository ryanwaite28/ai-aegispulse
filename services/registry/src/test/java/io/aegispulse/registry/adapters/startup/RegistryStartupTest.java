package io.aegispulse.registry.adapters.startup;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class RegistryStartupTest {
  @Test
  void FR_TEN_07_secretVariableNamesFollowSection10_4() {
    assertThat(RegistryStartup.secretVariable("svc-gateway"))
        .isEqualTo("SERVICE_CLIENT_SECRET_GATEWAY");
    assertThat(RegistryStartup.secretVariable("svc-doc-extraction"))
        .isEqualTo("SERVICE_CLIENT_SECRET_DOC_EXTRACTION");
    assertThat(RegistryStartup.secretVariable("svc-scheduler-trigger"))
        .isEqualTo("SERVICE_CLIENT_SECRET_SCHEDULER_TRIGGER");
  }
}
