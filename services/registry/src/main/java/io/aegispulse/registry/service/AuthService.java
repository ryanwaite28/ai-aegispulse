package io.aegispulse.registry.service;

import io.aegispulse.platform.db.TenantScope;
import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.platform.security.AegisPrincipal;
import io.aegispulse.registry.db.RefreshTokenRepository;
import io.aegispulse.registry.db.ServiceAccountRepository;
import io.aegispulse.registry.db.TenantRepository;
import io.aegispulse.registry.db.UserRepository;
import io.aegispulse.registry.domain.EmailAddress;
import io.aegispulse.registry.domain.PasswordPolicy;
import io.aegispulse.registry.domain.Role;
import io.aegispulse.registry.domain.Secrets;
import io.aegispulse.registry.domain.Tenant;
import io.aegispulse.registry.domain.TenantStatus;
import io.aegispulse.registry.domain.UserStatus;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * User authentication (FR-AUTH-01/02/03/07). Each action runs in one explicit transaction whose
 * outcome is decided before any error is thrown, so revocations and audit events commit even when
 * the caller gets a 401.
 */
@Service
public class AuthService {
  private static final Logger log = LoggerFactory.getLogger(AuthService.class);
  public static final Duration REFRESH_TTL = Duration.ofDays(7);
  static final int REFRESH_BYTES = 32;

  private final TenantRepository tenants;
  private final UserRepository users;
  private final RefreshTokenRepository refreshTokens;
  private final ServiceAccountRepository serviceAccounts;
  private final TenantScope scope;
  private final PasswordHasher hasher;
  private final TokenIssuer issuer;
  private final Throttle throttle;
  private final RegistryEvents events;
  private final TransactionTemplate tx;
  private final Clock clock;
  private final String dummyHash;

  public AuthService(
      TenantRepository tenants,
      UserRepository users,
      RefreshTokenRepository refreshTokens,
      ServiceAccountRepository serviceAccounts,
      TenantScope scope,
      PasswordHasher hasher,
      TokenIssuer issuer,
      Throttle throttle,
      RegistryEvents events,
      PlatformTransactionManager transactions,
      Clock clock) {
    this.tenants = tenants;
    this.users = users;
    this.refreshTokens = refreshTokens;
    this.serviceAccounts = serviceAccounts;
    this.scope = scope;
    this.hasher = hasher;
    this.issuer = issuer;
    this.throttle = throttle;
    this.events = events;
    this.tx = new TransactionTemplate(transactions);
    this.clock = clock;
    this.dummyHash = hasher.hash(Secrets.randomToken(24)); // equalizes unknown-user timing
  }

  private sealed interface Outcome<T> {}

  private record Ok<T>(T value) implements Outcome<T> {}

  private record Fail<T>(DomainException error) implements Outcome<T> {}

  private static <T> T unwrap(@Nullable Outcome<T> outcome) {
    return switch (outcome) {
      case Ok<T> ok -> ok.value();
      case Fail<T> fail -> throw fail.error();
      case null -> throw new IllegalStateException("no outcome");
    };
  }

  static DomainException invalidCredentials() {
    return new DomainException.Unauthorized("AUTH_INVALID_CREDENTIALS", "invalid credentials");
  }

  static DomainException refreshInvalid() {
    return new DomainException.Unauthorized(
        "AUTH_REFRESH_INVALID", "refresh token invalid, expired or reused");
  }

  static DomainException tenantSuspended() {
    return new DomainException.Forbidden("TENANT_SUSPENDED", "tenant is suspended or deactivated");
  }

  /** FR-AUTH-01. Uniform 401s; 5 failures per 15 min per (tenant, email) → 429. */
  public AuthViews.TokenPair login(Commands.Login cmd) {
    String email = cmd.email().strip().toLowerCase(Locale.ROOT);
    Optional<Tenant> tenant = tenants.findBySlug(cmd.tenantSlug());
    Throttle.Key key =
        Throttle.login(tenant.map(Tenant::id).orElse(Throttle.UNKNOWN_TENANT), email);
    throttle.check(key);
    Outcome<AuthViews.TokenPair> outcome =
        tx.execute(s -> {
          if (tenant.isEmpty()) {
            hasher.verify(cmd.password(), dummyHash);
            return new Fail<>(invalidCredentials());
          }
          Tenant t = tenant.get();
          scope.apply(t.id());
          Optional<UserRepository.Credentials> found = users.credentialsByEmail(email);
          if (found.isEmpty()) {
            hasher.verify(cmd.password(), dummyHash);
            return new Fail<>(invalidCredentials());
          }
          UserRepository.Credentials user = found.get();
          if (!hasher.verify(cmd.password(), user.passwordHash())
              || user.status() != UserStatus.ACTIVE) {
            return new Fail<>(invalidCredentials());
          }
          if (t.status() != TenantStatus.ACTIVE) {
            return new Fail<>(tenantSuspended());
          }
          users.recordLogin(user.id(), clock.instant());
          String refresh = newFamily(t.id(), user.id());
          log.info("auth.login.succeeded tenantId={} userId={}", t.id(), user.id());
          return new Ok<>(pair(t, user, refresh));
        });
    if (outcome instanceof Fail<AuthViews.TokenPair> fail
        && "AUTH_INVALID_CREDENTIALS".equals(fail.error().code())) {
      throttle.fail(key);
      log.info("auth.login.failed tenantId={}", tenant.map(Tenant::id).orElse(null));
    } else if (outcome instanceof Ok<AuthViews.TokenPair>) {
      throttle.clear(key);
    }
    return unwrap(outcome);
  }

  /** FR-AUTH-02: rotation; reuse of a rotated token revokes the family and is audited. */
  public AuthViews.TokenPair refresh(String refreshToken) {
    String sha = Secrets.sha256Hex(refreshToken);
    return unwrap(
        tx.execute(s -> {
          Optional<RefreshTokenRepository.Lookup> found = refreshTokens.lookup(sha);
          if (found.isEmpty()) {
            return new Fail<>(refreshInvalid());
          }
          RefreshTokenRepository.Lookup row = found.get();
          scope.apply(row.tenantId());
          Tenant t = tenants.findById(row.tenantId()).orElseThrow();
          if ("REVOKED".equals(row.status())) {
            return new Fail<>(refreshInvalid());
          }
          if ("ROTATED".equals(row.status()) || !refreshTokens.markRotated(row.id())) {
            return reuse(t, row);
          }
          if (!row.expiresAt().isAfter(clock.instant())) {
            return new Fail<>(refreshInvalid());
          }
          if (t.status() != TenantStatus.ACTIVE) {
            refreshTokens.revokeFamily(row.familyId());
            return new Fail<>(tenantSuspended());
          }
          Optional<UserRepository.Credentials> user = users.credentialsById(row.userId());
          if (user.isEmpty() || user.get().status() != UserStatus.ACTIVE) {
            refreshTokens.revokeFamily(row.familyId());
            return new Fail<>(refreshInvalid());
          }
          String next = Secrets.randomToken(REFRESH_BYTES);
          refreshTokens.insert(
              t.id(),
              row.userId(),
              row.familyId(),
              Secrets.sha256Hex(next),
              clock.instant().plus(REFRESH_TTL));
          return new Ok<>(pair(t, user.get(), next));
        }));
  }

  private Outcome<AuthViews.TokenPair> reuse(Tenant t, RefreshTokenRepository.Lookup row) {
    refreshTokens.revokeFamily(row.familyId());
    events.refreshReuseDetected(t.id(), t.slug(), row.userId(), row.familyId());
    log.warn(
        "auth.refresh.reuse_detected tenantId={} userId={} familyId={}",
        t.id(),
        row.userId(),
        row.familyId());
    return new Fail<>(refreshInvalid());
  }

  /** FR-AUTH-03: revokes the presented token's family if it belongs to the caller; else no-op. */
  public void logout(AegisPrincipal principal, String refreshToken) {
    if (principal instanceof AegisPrincipal.Integration) {
      return; // FR-AUTH-03: INTEGRATION tokens have no refresh family; logout is a no-op (§8.3
      // roles)
    }
    AegisPrincipal.User user = TenantAccess.requireUser(principal);
    UUID userId = TenantAccess.uuid(user.userId());
    tx.executeWithoutResult(s ->
        refreshTokens
            .lookup(Secrets.sha256Hex(refreshToken))
            .filter(r -> r.userId().equals(userId))
            .ifPresent(r -> {
              scope.apply(r.tenantId());
              refreshTokens.revokeFamily(r.familyId());
            }));
  }

  /** FR-AUTH-07: verify, apply policy, store, keep only the named session. */
  public void changePassword(AegisPrincipal principal, Commands.ChangePassword cmd) {
    AegisPrincipal.User caller = TenantAccess.requireUser(principal);
    TenantAccess.requireRole("changePassword", caller.roles());
    UUID userId = TenantAccess.uuid(caller.userId());
    UUID tenantId = TenantAccess.uuid(caller.tenantId());
    Throttle.Key key =
        tx.execute(s -> {
          scope.apply(tenantId);
          return users
              .credentialsById(userId)
              .map(u -> Throttle.login(tenantId, u.email()))
              .orElseThrow(AuthService::invalidCredentials);
        });
    throttle.check(java.util.Objects.requireNonNull(key));
    Outcome<Boolean> outcome =
        tx.execute(s -> {
          scope.apply(tenantId);
          Tenant t = tenants.findById(tenantId).orElseThrow(AuthService::invalidCredentials);
          UserRepository.Credentials user =
              users.credentialsById(userId).orElseThrow(AuthService::invalidCredentials);
          if (!hasher.verify(cmd.currentPassword(), user.passwordHash())) {
            return new Fail<>(invalidCredentials());
          }
          PasswordPolicy.check(
              cmd.newPassword(),
              List.of(EmailAddress.parse(user.email()).localPart(), user.displayName(), t.slug()));
          users.updatePassword(userId, hasher.hash(cmd.newPassword()));
          UUID keep =
              cmd.refreshToken() == null
                  ? null
                  : refreshTokens
                      .lookup(Secrets.sha256Hex(cmd.refreshToken()))
                      .filter(r -> r.userId().equals(userId) && "ACTIVE".equals(r.status()))
                      .map(RefreshTokenRepository.Lookup::familyId)
                      .orElse(null);
          refreshTokens.revokeUser(userId, keep);
          events.userChanged(tenantId, t.slug(), userId, List.of("password"), userId, false);
          log.info("auth.password_changed tenantId={} userId={}", tenantId, userId);
          return new Ok<>(Boolean.TRUE);
        });
    if (outcome instanceof Fail<Boolean>) {
      throttle.fail(key);
    }
    unwrap(outcome);
  }

  /** FR-AUTH-03 GET /me for user, integration and service tokens. */
  public AuthViews.Principal currentPrincipal(AegisPrincipal principal) {
    return switch (principal) {
      case AegisPrincipal.User u ->
          tx.execute(s -> {
            UUID tenantId = TenantAccess.uuid(u.tenantId());
            scope.apply(tenantId);
            Tenant t = tenants.findById(tenantId).orElseThrow(AuthService::invalidCredentials);
            UserRepository.Credentials user =
                users
                    .credentialsById(TenantAccess.uuid(u.userId()))
                    .orElseThrow(AuthService::invalidCredentials);
            return new AuthViews.Principal(
                "user",
                user.id(),
                user.email(),
                user.displayName(),
                user.roles().stream().map(Role::name).sorted().toList(),
                user.mustChangePassword(),
                ref(t));
          });
      case AegisPrincipal.Integration i -> {
        Tenant t =
            tenants
                .findById(TenantAccess.uuid(i.tenantId()))
                .orElseThrow(AuthService::invalidCredentials);
        yield new AuthViews.Principal(
            "integration",
            accountId(i.clientId()),
            null,
            null,
            List.of("INTEGRATION"),
            false,
            ref(t));
      }
      case AegisPrincipal.Service svc ->
          new AuthViews.Principal(
              "service", accountId(svc.clientId()), null, null, List.of(), false, null);
    };
  }

  private UUID accountId(String clientId) {
    return serviceAccounts.credentials(clientId).stream()
        .findFirst()
        .map(ServiceAccountRepository.CredentialRow::id)
        .orElseThrow(AuthService::invalidCredentials);
  }

  private static AuthViews.TenantRef ref(Tenant t) {
    return new AuthViews.TenantRef(t.id(), t.slug(), t.displayName(), t.status());
  }

  private String newFamily(UUID tenantId, UUID userId) {
    String token = Secrets.randomToken(REFRESH_BYTES);
    refreshTokens.insert(
        tenantId,
        userId,
        UUID.randomUUID(),
        Secrets.sha256Hex(token),
        clock.instant().plus(REFRESH_TTL));
    return token;
  }

  private AuthViews.TokenPair pair(Tenant t, UserRepository.Credentials user, String refresh) {
    return new AuthViews.TokenPair(
        issuer.user(user.id(), t, user.roles()),
        refresh,
        "Bearer",
        TokenIssuer.ACCESS_TTL.toSeconds(),
        user.mustChangePassword());
  }
}
