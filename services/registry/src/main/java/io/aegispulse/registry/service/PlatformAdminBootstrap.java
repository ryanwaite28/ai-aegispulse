package io.aegispulse.registry.service;

import io.aegispulse.platform.db.TenantScope;
import io.aegispulse.registry.db.TenantRepository;
import io.aegispulse.registry.db.UserRepository;
import io.aegispulse.registry.domain.EmailAddress;
import io.aegispulse.registry.domain.PasswordPolicy;
import io.aegispulse.registry.domain.PlatformTenant;
import io.aegispulse.registry.domain.Role;
import java.util.EnumSet;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * FR-TEN-09: creates the first PLATFORM_ADMIN in the reserved platform tenant when none is active
 * (no-op otherwise), with a forced password change and a SYSTEM-actor audit event.
 */
@Service
public class PlatformAdminBootstrap {
  private static final Logger log = LoggerFactory.getLogger(PlatformAdminBootstrap.class);
  static final String DISPLAY_NAME = "Platform Admin";

  /** Result of one run. */
  public enum Outcome {
    CREATED,
    NOOP
  }

  private final TenantRepository tenants;
  private final UserRepository users;
  private final TenantScope scope;
  private final PasswordHasher hasher;
  private final RegistryEvents events;

  public PlatformAdminBootstrap(
      TenantRepository tenants,
      UserRepository users,
      TenantScope scope,
      PasswordHasher hasher,
      RegistryEvents events) {
    this.tenants = tenants;
    this.users = users;
    this.scope = scope;
    this.hasher = hasher;
    this.events = events;
  }

  @Transactional
  public Outcome run(String rawEmail, String password) {
    scope.apply(PlatformTenant.ID);
    if (tenants.lockById(PlatformTenant.ID).isEmpty()) {
      throw new IllegalStateException("platform tenant missing: run migrations");
    }
    if (users.anyActivePlatformAdmin()) {
      log.info("bootstrap.noop reason=active_platform_admin_exists");
      return Outcome.NOOP;
    }
    EmailAddress email = EmailAddress.parse(rawEmail);
    PasswordPolicy.check(password, List.of(email.localPart(), DISPLAY_NAME, PlatformTenant.SLUG));
    UUID id =
        users.insert(
            PlatformTenant.ID,
            email.value(),
            DISPLAY_NAME,
            hasher.hash(password),
            EnumSet.of(Role.PLATFORM_ADMIN),
            null);
    events.userChanged(
        PlatformTenant.ID, PlatformTenant.SLUG, id, UserService.CREATED_FIELDS, null, false);
    log.info("bootstrap.created userId={}", id);
    return Outcome.CREATED;
  }
}
