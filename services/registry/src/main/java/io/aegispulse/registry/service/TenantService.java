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
    TenantAccess.requireRole("createTenant", user.roles());
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
    TenantAccess.requireRole("updateTenantStatus", user.roles());
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

  /**
   * FR-TEN-08 read (callers cache ≤ 60 s): PLATFORM_ADMIN any tenant, TENANT_ADMIN its own (other
   * tenants read as 404), SERVICE callers per their act[] allowlist.
   */
  @Transactional(readOnly = true)
  public Tenant settings(AegisPrincipal principal, @Nullable UUID actingTenant, UUID tenantId) {
    authorizeTenantRead("getTenantSettings", principal, actingTenant, tenantId);
    if (PlatformTenant.is(tenantId)) {
      throw notFound();
    }
    return tenants.findById(tenantId).orElseThrow(TenantService::notFound);
  }

  /** FR-TEN-08 update: TENANT_ADMIN of the tenant or PLATFORM_ADMIN; emits settings_changed. */
  @Transactional
  public Tenant updateSettings(
      AegisPrincipal principal,
      @Nullable UUID actingTenant,
      @Nullable String idempotencyKey,
      Commands.UpdateTenantSettings cmd) {
    boolean actingAsPa =
        authorizeTenantRead("updateTenantSettings", principal, actingTenant, cmd.tenantId());
    if (PlatformTenant.is(cmd.tenantId())) {
      throw notFound();
    }
    if (cmd.highValueThresholdUsd() == null
        && cmd.highRiskCountries() == null
        && cmd.retentionDays() == null
        && cmd.demoMode() == null) {
      throw new DomainException.Validation(
          "VALIDATION_ERROR",
          "request failed validation",
          List.of(new DomainException.ErrorDetail("body", "at least one setting is required")));
    }
    AegisPrincipal.User user = TenantAccess.requireUser(principal);
    UUID actor = TenantAccess.uuid(user.userId());
    UUID home = TenantAccess.uuid(user.tenantId());
    scope.apply(home);
    return idempotency.run(
        home,
        "updateTenantSettings",
        idempotencyKey,
        cmd,
        200,
        Tenant.class,
        () -> {
          Tenant current = tenants.lockById(cmd.tenantId()).orElseThrow(TenantService::notFound);
          BigDecimal threshold =
              cmd.highValueThresholdUsd() == null
                  ? current.highValueThresholdUsd()
                  : new BigDecimal(cmd.highValueThresholdUsd());
          List<String> countries =
              cmd.highRiskCountries() == null
                  ? current.highRiskCountries()
                  : cmd.highRiskCountries().stream().distinct().sorted().toList();
          int retention =
              cmd.retentionDays() == null ? current.retentionDays() : cmd.retentionDays();
          boolean demo = cmd.demoMode() == null ? current.demoMode() : cmd.demoMode();
          List<String> changed = new java.util.ArrayList<>();
          if (threshold.compareTo(current.highValueThresholdUsd()) != 0) {
            changed.add("highValueThresholdUsd");
          }
          if (!countries.equals(current.highRiskCountries())) {
            changed.add("highRiskCountries");
          }
          if (retention != current.retentionDays()) {
            changed.add("retentionDays");
          }
          if (demo != current.demoMode()) {
            changed.add("demoMode");
          }
          if (changed.isEmpty()) {
            return current;
          }
          Tenant updated =
              tenants.updateSettings(current.id(), threshold, countries, retention, demo);
          events.tenantSettingsChanged(updated, List.copyOf(changed), actor, actingAsPa);
          log.info(
              "tenant.settings_changed tenantId={} changed={} actorId={}",
              updated.id(),
              changed,
              actor);
          return updated;
        });
  }

  /**
   * Tenant-detail authorization: SERVICE by act[] (checked by the adapter), PLATFORM_ADMIN any
   * tenant, tenant roles only their own (otherwise 404, FR-AUTH-06). Returns whether a
   * PLATFORM_ADMIN acted on another tenant.
   */
  private static boolean authorizeTenantRead(
      String action, AegisPrincipal principal, @Nullable UUID actingTenant, UUID tenantId) {
    if (principal instanceof AegisPrincipal.Service) {
      if (actingTenant != null) {
        throw new DomainException.Forbidden(
            "FORBIDDEN", "X-Aegis-Tenant is for PLATFORM_ADMIN only");
      }
      if (action.equals("getTenantSettings")) {
        return false;
      }
      throw new DomainException.Forbidden("FORBIDDEN", "this action requires a user token");
    }
    AegisPrincipal.User user = TenantAccess.requireUser(principal);
    TenantAccess.requireRole(action, user.roles());
    if (user.hasAnyRole(io.aegispulse.registry.domain.Role.PLATFORM_ADMIN.name())) {
      return true;
    }
    if (actingTenant != null) {
      throw new DomainException.Forbidden("FORBIDDEN", "X-Aegis-Tenant is for PLATFORM_ADMIN only");
    }
    if (!TenantAccess.uuid(user.tenantId()).equals(tenantId)) {
      throw notFound();
    }
    return false;
  }

  static DomainException notFound() {
    return new DomainException.NotFound("NOT_FOUND", "tenant not found");
  }
}
