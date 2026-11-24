package io.aegispulse.registry.service;

import io.aegispulse.platform.db.TenantScope;
import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.platform.security.AegisPrincipal;
import io.aegispulse.registry.db.ServiceAccountRepository;
import io.aegispulse.registry.db.TenantRepository;
import io.aegispulse.registry.domain.Secrets;
import io.aegispulse.registry.domain.ServiceAccount;
import io.aegispulse.registry.domain.Tenant;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Service accounts: tenant INTEGRATION accounts (FR-TEN-06; TENANT_ADMIN or PLATFORM_ADMIN via
 * X-Aegis-Tenant) and the startup reconciliation of internal SERVICE secrets (FR-TEN-07, ADR-0017).
 * Secrets are returned once and stored only as Argon2id verifiers.
 */
@Service
public class ServiceAccountService {
  private static final Logger log = LoggerFactory.getLogger(ServiceAccountService.class);
  public static final Duration ROTATION_GRACE = Duration.ofHours(24);
  static final int SECRET_BYTES = 32;
  static final int CLIENT_ID_BYTES = 16;
  static final int DEFAULT_LIMIT = 25;

  private final ServiceAccountRepository accounts;
  private final TenantRepository tenants;
  private final TenantScope scope;
  private final PasswordHasher hasher;
  private final Idempotency idempotency;
  private final RegistryEvents events;
  private final Clock clock;

  public ServiceAccountService(
      ServiceAccountRepository accounts,
      TenantRepository tenants,
      TenantScope scope,
      PasswordHasher hasher,
      Idempotency idempotency,
      RegistryEvents events,
      Clock clock) {
    this.accounts = accounts;
    this.tenants = tenants;
    this.scope = scope;
    this.hasher = hasher;
    this.idempotency = idempotency;
    this.events = events;
    this.clock = clock;
  }

  @Transactional
  public AuthViews.ServiceAccountWithSecret create(
      AegisPrincipal principal,
      @Nullable UUID actingTenant,
      @Nullable String idempotencyKey,
      Commands.CreateServiceAccount cmd) {
    TenantAccess access =
        TenantAccess.forTenantAction("createServiceAccount", principal, actingTenant);
    Tenant tenant = enter(access);
    return idempotency.runOnce(
        access.tenantId(),
        "createServiceAccount",
        idempotencyKey,
        cmd,
        201,
        (AuthViews.ServiceAccountWithSecret r) -> r.id().toString(),
        () -> {
          String secret = Secrets.randomToken(SECRET_BYTES);
          ServiceAccount account =
              accounts.insertIntegration(
                  access.tenantId(),
                  "int_" + Secrets.randomToken(CLIENT_ID_BYTES),
                  cmd.name().strip(),
                  access.actingAsPlatformAdmin() ? null : access.actorId());
          accounts.insertSecret(account.id(), hasher.hash(secret));
          audit(tenant, account, List.of("created"), access);
          return AuthViews.ServiceAccountWithSecret.of(account, secret, null);
        });
  }

  @Transactional(readOnly = true)
  public Page<ServiceAccount> list(
      AegisPrincipal principal, @Nullable UUID actingTenant, Commands.ListServiceAccounts query) {
    TenantAccess access =
        TenantAccess.forTenantAction("listServiceAccounts", principal, actingTenant);
    enter(access);
    int limit = query.limit() == null ? DEFAULT_LIMIT : query.limit();
    ServiceAccountRepository.Position after =
        query.cursor() == null ? null : decodeCursor(query.cursor());
    List<ServiceAccount> rows = accounts.list(query.status(), after, limit + 1);
    if (rows.size() <= limit) {
      return new Page<>(rows, null);
    }
    ServiceAccount last = rows.get(limit - 1);
    return new Page<>(
        List.copyOf(rows.subList(0, limit)), encodeCursor(last.createdAt(), last.id()));
  }

  @Transactional
  public AuthViews.ServiceAccountWithSecret rotate(
      AegisPrincipal principal,
      @Nullable UUID actingTenant,
      @Nullable String idempotencyKey,
      UUID serviceAccountId) {
    TenantAccess access =
        TenantAccess.forTenantAction("rotateServiceAccountSecret", principal, actingTenant);
    Tenant tenant = enter(access);
    return idempotency.runOnce(
        access.tenantId(),
        "rotateServiceAccountSecret",
        idempotencyKey,
        Map.of("serviceAccountId", serviceAccountId),
        200,
        (AuthViews.ServiceAccountWithSecret r) -> r.id().toString(),
        () -> {
          ServiceAccount account = activeAccount(serviceAccountId);
          Instant graceUntil = clock.instant().plus(ROTATION_GRACE);
          accounts.graceOpenSecrets(account.id(), graceUntil);
          String secret = Secrets.randomToken(SECRET_BYTES);
          accounts.insertSecret(account.id(), hasher.hash(secret));
          audit(tenant, account, List.of("secret"), access);
          return AuthViews.ServiceAccountWithSecret.of(
              account, secret, graceUntil.atOffset(ZoneOffset.UTC));
        });
  }

  @Transactional
  public ServiceAccount revoke(
      AegisPrincipal principal, @Nullable UUID actingTenant, UUID serviceAccountId) {
    TenantAccess access =
        TenantAccess.forTenantAction("revokeServiceAccount", principal, actingTenant);
    Tenant tenant = enter(access);
    ServiceAccount account = found(serviceAccountId);
    if (account.status() == ServiceAccount.Status.REVOKED) {
      return account;
    }
    ServiceAccount revoked = accounts.revoke(account.id());
    audit(tenant, revoked, List.of("status"), access);
    return revoked;
  }

  /** Startup (ADR-0017): one result line per seeded SERVICE client. */
  public enum Reconciled {
    UNCHANGED,
    ROTATED_IN,
    MISSING
  }

  /** Clients seeded by R__seed_service_accounts.sql. */
  @Transactional(readOnly = true)
  public List<String> serviceClientIds() {
    return accounts.serviceClientIds();
  }

  /**
   * Reconciles one SERVICE client's verifier with its configured secret (null = not configured).
   * Matching an open-ended verifier is a no-op; otherwise the new verifier is added and the old
   * ones stay valid for 24 h.
   */
  @Transactional
  public Reconciled reconcile(String clientId, @Nullable String secret) {
    if (secret == null || secret.isEmpty()) {
      log.warn("service_account.secret_missing clientId={}", clientId);
      return Reconciled.MISSING;
    }
    for (ServiceAccountRepository.CredentialRow row : accounts.credentials(clientId)) {
      if (row.secretHash() != null
          && row.validUntil() == null
          && hasher.verify(secret, row.secretHash())) {
        return Reconciled.UNCHANGED;
      }
    }
    if (!accounts.addServiceSecret(
        clientId, hasher.hash(secret), clock.instant().plus(ROTATION_GRACE))) {
      throw new IllegalStateException("not an active SERVICE account: " + clientId);
    }
    log.info("service_account.secret_reconciled clientId={}", clientId);
    return Reconciled.ROTATED_IN;
  }

  private ServiceAccount activeAccount(UUID id) {
    ServiceAccount account = found(id);
    if (account.status() != ServiceAccount.Status.ACTIVE) {
      throw new DomainException.Conflict("CONFLICT", "service account is revoked");
    }
    return account;
  }

  private ServiceAccount found(UUID id) {
    return accounts
        .findById(id)
        .orElseThrow(() -> new DomainException.NotFound("NOT_FOUND", "service account not found"));
  }

  private void audit(Tenant t, ServiceAccount a, List<String> changed, TenantAccess access) {
    events.serviceAccountChanged(
        t.id(),
        t.slug(),
        a.id(),
        a.clientId(),
        changed,
        access.actorId(),
        access.actingAsPlatformAdmin());
    log.info(
        "service_account.changed tenantId={} serviceAccountId={} changed={} actorId={}",
        t.id(),
        a.id(),
        changed,
        access.actorId());
  }

  private Tenant enter(TenantAccess access) {
    Tenant tenant =
        tenants
            .findById(access.tenantId())
            .orElseThrow(() -> new DomainException.NotFound("NOT_FOUND", "tenant not found"));
    scope.apply(access.tenantId());
    return tenant;
  }

  static String encodeCursor(OffsetDateTime createdAt, UUID id) {
    return Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString((createdAt + "|" + id).getBytes(StandardCharsets.UTF_8));
  }

  static ServiceAccountRepository.Position decodeCursor(String cursor) {
    try {
      String raw = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
      int bar = raw.indexOf('|');
      return new ServiceAccountRepository.Position(
          OffsetDateTime.parse(raw.substring(0, bar)), UUID.fromString(raw.substring(bar + 1)));
    } catch (IllegalArgumentException
        | DateTimeParseException
        | StringIndexOutOfBoundsException e) {
      throw new DomainException.Validation(
          "VALIDATION_ERROR",
          "request failed validation",
          List.of(new DomainException.ErrorDetail("cursor", "invalid cursor")));
    }
  }
}
