package io.aegispulse.registry.service;

import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.registry.db.ServiceAccountRepository;
import io.aegispulse.registry.db.TenantRepository;
import io.aegispulse.registry.domain.Secrets;
import io.aegispulse.registry.domain.ServiceAccount;
import io.aegispulse.registry.domain.Tenant;
import io.aegispulse.registry.domain.TenantStatus;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * FR-AUTH-04 / FR-TEN-07 client credentials: the only unauthenticated internal action. Uniform
 * 401s; 10 failures per 5 min per clientId → 429. INTEGRATION → typ=integration on JWT_AUDIENCE;
 * SERVICE → typ=service on aegispulse-internal with the account's act[].
 */
@Service
public class ClientCredentialsService {
  private static final Logger log = LoggerFactory.getLogger(ClientCredentialsService.class);
  static final String PUBLIC_AUDIENCE = "aegispulse";
  static final String INTERNAL_AUDIENCE = "aegispulse-internal";

  private final ServiceAccountRepository accounts;
  private final TenantRepository tenants;
  private final PasswordHasher hasher;
  private final TokenIssuer issuer;
  private final Throttle throttle;
  private final Clock clock;
  private final String dummyHash;

  public ClientCredentialsService(
      ServiceAccountRepository accounts,
      TenantRepository tenants,
      PasswordHasher hasher,
      TokenIssuer issuer,
      Throttle throttle,
      Clock clock) {
    this.accounts = accounts;
    this.tenants = tenants;
    this.hasher = hasher;
    this.issuer = issuer;
    this.throttle = throttle;
    this.clock = clock;
    this.dummyHash = hasher.hash(Secrets.randomToken(24));
  }

  public AuthViews.AccessToken issue(Commands.IssueClientCredentials cmd) {
    Throttle.Key key = Throttle.clientCredentials(cmd.clientId());
    throttle.check(key);
    List<ServiceAccountRepository.CredentialRow> rows = accounts.credentials(cmd.clientId());
    if (rows.isEmpty()) {
      hasher.verify(cmd.clientSecret(), dummyHash);
      throw failure(key, "unknown_client");
    }
    ServiceAccountRepository.CredentialRow account = rows.getFirst();
    if (!verifies(cmd.clientSecret(), rows, clock.instant())) {
      throw failure(key, "bad_secret");
    }
    if (account.status() != ServiceAccount.Status.ACTIVE) {
      throw failure(key, "revoked");
    }
    String token;
    if (account.kind() == ServiceAccount.Kind.SERVICE) {
      if (!INTERNAL_AUDIENCE.equals(cmd.audience())) {
        throw failure(key, "audience");
      }
      token = issuer.service(cmd.clientId(), account.allowedActions());
    } else {
      if (!PUBLIC_AUDIENCE.equals(cmd.audience())) {
        throw failure(key, "audience");
      }
      Tenant tenant =
          tenants
              .findById(Objects.requireNonNull(account.tenantId()))
              .orElseThrow(() -> failure(key, "tenant"));
      if (tenant.status() != TenantStatus.ACTIVE) {
        throw AuthService.tenantSuspended();
      }
      token = issuer.integration(cmd.clientId(), tenant);
    }
    throttle.clear(key);
    log.info("auth.client_credentials.issued clientId={} kind={}", cmd.clientId(), account.kind());
    return new AuthViews.AccessToken(token, "Bearer", TokenIssuer.ACCESS_TTL.toSeconds());
  }

  /** A secret is valid while its verifier is open-ended or inside its grace window. */
  private boolean verifies(
      String secret, List<ServiceAccountRepository.CredentialRow> rows, Instant now) {
    boolean ok = false;
    for (ServiceAccountRepository.CredentialRow row : rows) {
      String hash = row.secretHash();
      Instant until = row.validUntil();
      if (hash != null && (until == null || until.isAfter(now)) && hasher.verify(secret, hash)) {
        ok = true;
      }
    }
    return ok;
  }

  private DomainException failure(Throttle.Key key, String reason) {
    throttle.fail(key);
    log.info("auth.client_credentials.failed reason={}", reason);
    return new DomainException.Unauthorized(
        "AUTH_INVALID_CREDENTIALS", "invalid client credentials");
  }
}
