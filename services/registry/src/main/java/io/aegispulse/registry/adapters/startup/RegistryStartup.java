package io.aegispulse.registry.adapters.startup;

import io.aegispulse.registry.service.ServiceAccountService;
import io.aegispulse.registry.service.SigningKeys;
import java.util.EnumMap;
import java.util.Locale;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/**
 * Web-mode startup, before readiness (runners complete before ApplicationReadyEvent): reads the
 * §10.4 variables and hands them to the services. Registers the signing key (FR-AUTH-05) and
 * reconciles SERVICE secret verifiers (ADR-0017). Values are never logged.
 */
@Component
@ConditionalOnWebApplication
class RegistryStartup implements ApplicationRunner {
  private static final Logger log = LoggerFactory.getLogger(RegistryStartup.class);

  private final SigningKeys signingKeys;
  private final ServiceAccountService serviceAccounts;
  private final Environment env;

  RegistryStartup(SigningKeys signingKeys, ServiceAccountService serviceAccounts, Environment env) {
    this.signingKeys = signingKeys;
    this.serviceAccounts = serviceAccounts;
    this.env = env;
  }

  /** svc-doc-extraction → SERVICE_CLIENT_SECRET_DOC_EXTRACTION. */
  static String secretVariable(String clientId) {
    return "SERVICE_CLIENT_SECRET_"
        + clientId.substring("svc-".length()).toUpperCase(Locale.ROOT).replace('-', '_');
  }

  @Override
  public void run(ApplicationArguments args) {
    signingKeys.register(
        env.getProperty("JWT_SIGNING_KEY_CURRENT_PEM", ""),
        env.getProperty("JWT_SIGNING_KEY_CURRENT_KID", ""));
    Map<ServiceAccountService.Reconciled, Integer> summary =
        new EnumMap<>(ServiceAccountService.Reconciled.class);
    for (String clientId : serviceAccounts.serviceClientIds()) {
      ServiceAccountService.Reconciled r =
          serviceAccounts.reconcile(clientId, env.getProperty(secretVariable(clientId)));
      summary.merge(r, 1, Integer::sum);
    }
    log.info("service_accounts.reconciled {}", summary);
  }
}
