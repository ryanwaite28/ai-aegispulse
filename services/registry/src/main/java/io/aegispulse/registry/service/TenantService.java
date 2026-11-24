package io.aegispulse.registry.service;

import io.aegispulse.platform.db.TenantScope;
import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.platform.security.AegisPrincipal;
import io.aegispulse.registry.db.TenantRepository;
import io.aegispulse.registry.domain.PlatformTenant;
import io.aegispulse.registry.domain.Tenant;
import io.aegispulse.registry.domain.TenantStateMachine;
import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Tenant lifecycle (FR-TEN-01/02/03): PLATFORM_ADMIN only; outbox events in the same transaction.
 */
@Service
public class TenantService {
  private static final Logger log = LoggerFactory.getLogger(TenantService.class);
  static final BigDecimal DEFAULT_THRESHOLD = new BigDecimal("50000");
  static final int DEFAULT_RETENTION_DAYS = 400;

  private final TenantRepository tenants;
  private final TenantScope scope;
  private final Idempotency idempotency;
  private final RegistryEvents events;

  public TenantService(
      TenantRepository tenants, TenantScope scope, Idempotency idempotency, RegistryEvents events) {
    this.tenants = tenants;
    this.scope = scope;
    this.idempotency = idempotency;
    this.events = events;
  }

  @Transactional
  public Tenant create(
      AegisPrincipal principal, @Nullable String idempotencyKey, Commands.CreateTenant cmd) {
    AegisPrincipal.User user = TenantAccess.requireUser(principal);
    TenantAccess.requirePlatformAdmin(user);
    if (idempotencyKey == null) {
      throw new DomainException.Validation(
          "VALIDATION_ERROR",
          "request failed validation",
          List.of(new DomainException.ErrorDetail("Idempotency-Key", "required for createTenant")));
    }
    UUID home = TenantAccess.uuid(user.tenantId());
    UUID actor = TenantAccess.uuid(user.userId());
    scope.apply(home);
    return idempotency.run(
        home,
        "createTenant",
        idempotencyKey,
        cmd,
        201,
        Tenant.class,
        () -> {
          Tenant t =
              tenants.insert(
                  new TenantRepository.NewTenant(
                      cmd.slug(),
                      cmd.displayName().strip(),
                      cmd.highValueThresholdUsd() == null
                          ? DEFAULT_THRESHOLD
                          : new BigDecimal(cmd.highValueThresholdUsd()),
                      cmd.highRiskCountries() == null
                          ? List.of()
                          : cmd.highRiskCountries().stream().distinct().sorted().toList(),
                      cmd.retentionDays() == null ? DEFAULT_RETENTION_DAYS : cmd.retentionDays(),
                      Boolean.TRUE.equals(cmd.demoMode())));
          events.tenantCreated(t, actor);
          log.info("tenant.created tenantId={} actorId={}", t.id(), actor);
          return t;
        });
  }

  @Transactional
  public Tenant updateStatus(
      AegisPrincipal principal, @Nullable String idempotencyKey, Commands.UpdateTenantStatus cmd) {
    AegisPrincipal.User user = TenantAccess.requireUser(principal);
    TenantAccess.requirePlatformAdmin(user);
    if (PlatformTenant.is(cmd.tenantId())) {
      throw notFound();
    }
    UUID home = TenantAccess.uuid(user.tenantId());
    UUID actor = TenantAccess.uuid(user.userId());
    scope.apply(home);
    return idempotency.run(
        home,
        "updateTenantStatus",
        idempotencyKey,
        cmd,
        200,
        Tenant.class,
        () -> {
          Tenant current = tenants.lockById(cmd.tenantId()).orElseThrow(TenantService::notFound);
          TenantStateMachine.Transition transition =
              TenantStateMachine.transition(current.status(), cmd.status());
          Tenant updated = tenants.updateStatus(cmd.tenantId(), cmd.status(), cmd.reason());
          events.tenantStatusChanged(updated, transition, cmd.reason(), actor);
          log.info(
              "tenant.status_changed tenantId={} status={} actorId={}",
              updated.id(),
              updated.status(),
              actor);
          return updated;
        });
  }

  static DomainException notFound() {
    return new DomainException.NotFound("NOT_FOUND", "tenant not found");
  }
}
