package io.aegispulse.registry.service;

import io.aegispulse.registry.domain.ServiceAccount;
import io.aegispulse.registry.domain.TenantStatus;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** Results of the auth and service-account actions (registry.internal.yaml shapes). */
public final class AuthViews {
  private AuthViews() {}

  /** TokenPair (FR-AUTH-01/02). */
  public record TokenPair(
      String accessToken,
      String refreshToken,
      String tokenType,
      long expiresIn,
      boolean mustChangePassword) {
    @Override
    public String toString() {
      return "TokenPair[<redacted>]";
    }
  }

  /** AccessToken (FR-AUTH-04): no refresh token. */
  public record AccessToken(String accessToken, String tokenType, long expiresIn) {
    @Override
    public String toString() {
      return "AccessToken[<redacted>]";
    }
  }

  /** Principal.tenant. */
  public record TenantRef(UUID id, String slug, String displayName, TenantStatus status) {}

  /** Principal (FR-AUTH-03). */
  public record Principal(
      String typ,
      UUID id,
      @Nullable String email,
      @Nullable String displayName,
      List<String> roles,
      boolean mustChangePassword,
      @Nullable TenantRef tenant) {}

  /** ServiceAccountWithSecret: the secret is shown exactly once (FR-TEN-06). */
  public record ServiceAccountWithSecret(
      UUID id,
      @Nullable UUID tenantId,
      String clientId,
      String name,
      ServiceAccount.Kind kind,
      ServiceAccount.Status status,
      OffsetDateTime createdAt,
      OffsetDateTime updatedAt,
      String clientSecret,
      @Nullable OffsetDateTime previousSecretValidUntil) {
    static ServiceAccountWithSecret of(
        ServiceAccount a, String secret, @Nullable OffsetDateTime previousValidUntil) {
      return new ServiceAccountWithSecret(
          a.id(),
          a.tenantId(),
          a.clientId(),
          a.name(),
          a.kind(),
          a.status(),
          a.createdAt(),
          a.updatedAt(),
          secret,
          previousValidUntil);
    }

    @Override
    public String toString() {
      return "ServiceAccountWithSecret[id="
          + id
          + ", clientId="
          + clientId
          + ", secret=<redacted>]";
    }
  }
}
