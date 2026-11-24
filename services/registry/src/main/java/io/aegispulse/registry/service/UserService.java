package io.aegispulse.registry.service;

import io.aegispulse.platform.db.TenantScope;
import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.platform.security.AegisPrincipal;
import io.aegispulse.registry.db.TenantRepository;
import io.aegispulse.registry.db.UserRepository;
import io.aegispulse.registry.domain.EmailAddress;
import io.aegispulse.registry.domain.LastAdminRule;
import io.aegispulse.registry.domain.PasswordPolicy;
import io.aegispulse.registry.domain.Role;
import io.aegispulse.registry.domain.Tenant;
import io.aegispulse.registry.domain.User;
import io.aegispulse.registry.domain.UserStatus;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Users and roles (FR-TEN-04/05): TENANT_ADMIN on its own tenant, or PLATFORM_ADMIN via
 * X-Aegis-Tenant. Every query runs under the effective tenant's RLS scope.
 */
@Service
public class UserService {
  private static final Logger log = LoggerFactory.getLogger(UserService.class);
  static final int DEFAULT_LIMIT = 25;
  static final List<String> CREATED_FIELDS = List.of("email", "displayName", "roles", "status");

  private final TenantRepository tenants;
  private final UserRepository users;
  private final TenantScope scope;
  private final Idempotency idempotency;
  private final PasswordHasher hasher;
  private final RegistryEvents events;

  public UserService(
      TenantRepository tenants,
      UserRepository users,
      TenantScope scope,
      Idempotency idempotency,
      PasswordHasher hasher,
      RegistryEvents events) {
    this.tenants = tenants;
    this.users = users;
    this.scope = scope;
    this.idempotency = idempotency;
    this.hasher = hasher;
    this.events = events;
  }

  @Transactional
  public User create(
      AegisPrincipal principal,
      @Nullable UUID actingTenant,
      @Nullable String idempotencyKey,
      Commands.CreateUser cmd) {
    TenantAccess access = TenantAccess.forTenantAdminAction(principal, actingTenant);
    Tenant tenant = enter(access);
    Set<Role> roles = Role.tenantRoles(cmd.roles());
    EmailAddress email = EmailAddress.parse(cmd.email());
    String displayName = cmd.displayName().strip();
    PasswordPolicy.check(
        cmd.initialPassword(), List.of(email.localPart(), displayName, tenant.slug()));
    return idempotency.run(
        access.tenantId(),
        "createUser",
        idempotencyKey,
        cmd.fingerprint(),
        201,
        User.class,
        () -> {
          UUID id =
              users.insert(
                  access.tenantId(),
                  email.value(),
                  displayName,
                  hasher.hash(cmd.initialPassword()),
                  roles,
                  access.actingAsPlatformAdmin() ? null : access.actorId());
          events.userChanged(
              access.tenantId(),
              tenant.slug(),
              id,
              CREATED_FIELDS,
              access.actorId(),
              access.actingAsPlatformAdmin());
          log.info(
              "user.created tenantId={} userId={} actorId={}",
              access.tenantId(),
              id,
              access.actorId());
          return users.findById(id).orElseThrow();
        });
  }

  @Transactional(readOnly = true)
  public Page<User> list(
      AegisPrincipal principal, @Nullable UUID actingTenant, Commands.ListUsers query) {
    TenantAccess access = TenantAccess.forTenantAdminAction(principal, actingTenant);
    enter(access);
    Role role =
        query.role() == null ? null : Role.tenantRoles(List.of(query.role())).iterator().next();
    int limit = query.limit() == null ? DEFAULT_LIMIT : query.limit();
    UserRepository.Position after = query.cursor() == null ? null : decodeCursor(query.cursor());
    List<User> rows = users.list(role, query.status(), after, limit + 1);
    if (rows.size() <= limit) {
      return new Page<>(rows, null);
    }
    List<User> page = rows.subList(0, limit);
    User last = page.get(limit - 1);
    return new Page<>(List.copyOf(page), encodeCursor(last.createdAt(), last.id()));
  }

  @Transactional
  public User update(
      AegisPrincipal principal,
      @Nullable UUID actingTenant,
      @Nullable String idempotencyKey,
      Commands.UpdateUser cmd) {
    TenantAccess access = TenantAccess.forTenantAdminAction(principal, actingTenant);
    Tenant tenant = enter(access);
    if (tenants.lockById(access.tenantId()).isEmpty()) { // serializes admin-affecting changes
      throw new DomainException.NotFound("NOT_FOUND", "tenant not found");
    }
    return idempotency.run(
        access.tenantId(),
        "updateUser",
        idempotencyKey,
        cmd,
        200,
        User.class,
        () -> {
          User current =
              users
                  .findById(cmd.userId())
                  .orElseThrow(() -> new DomainException.NotFound("NOT_FOUND", "user not found"));
          Set<Role> roles = cmd.roles() == null ? current.roles() : Role.tenantRoles(cmd.roles());
          UserStatus status = cmd.status() == null ? current.status() : cmd.status();
          String displayName =
              cmd.displayName() == null ? current.displayName() : cmd.displayName().strip();
          List<String> changed = new ArrayList<>();
          if (!displayName.equals(current.displayName())) {
            changed.add("displayName");
          }
          if (!roles.equals(current.roles())) {
            changed.add("roles");
          }
          if (status != current.status()) {
            changed.add("status");
          }
          if (changed.isEmpty()) {
            return current;
          }
          boolean wasActiveAdmin =
              current.status() == UserStatus.ACTIVE && current.roles().contains(Role.TENANT_ADMIN);
          if (wasActiveAdmin) {
            LastAdminRule.check(
                users.countOtherActiveTenantAdmins(current.id()),
                status == UserStatus.ACTIVE,
                roles);
          }
          if (changed.contains("displayName")) {
            users.updateDisplayName(current.id(), displayName);
          }
          if (changed.contains("roles")) {
            users.replaceRoles(
                access.tenantId(),
                current.id(),
                roles,
                access.actingAsPlatformAdmin() ? null : access.actorId());
          }
          if (changed.contains("status")) {
            users.updateStatus(current.id(), status);
          }
          // Refresh-token revocation on role change / disable is wired in slice 2b
          // (refresh_tokens).
          events.userChanged(
              access.tenantId(),
              tenant.slug(),
              current.id(),
              List.copyOf(changed),
              access.actorId(),
              access.actingAsPlatformAdmin());
          log.info(
              "user.updated tenantId={} userId={} changed={} actorId={}",
              access.tenantId(),
              current.id(),
              changed,
              access.actorId());
          return users.findById(current.id()).orElseThrow();
        });
  }

  /** Confirms the effective tenant exists and applies its RLS scope. */
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

  static UserRepository.Position decodeCursor(String cursor) {
    try {
      String raw = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
      int bar = raw.indexOf('|');
      return new UserRepository.Position(
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
