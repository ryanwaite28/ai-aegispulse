package io.aegispulse.registry.service;

import io.aegispulse.registry.domain.TenantStatus;
import io.aegispulse.registry.domain.UserStatus;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * Inputs of the registry tenant/user actions (packages/contracts/openapi/registry.internal.yaml).
 */
public final class Commands {
  private Commands() {}

  static final String DECIMAL = "^(?=.*[1-9])[0-9]{1,18}(\\.[0-9]{1,4})?$";

  /** CreateTenantInput (FR-TEN-01). */
  public record CreateTenant(
      @NotNull @Pattern(regexp = "^[a-z0-9-]{3,40}$") String slug,
      @NotNull @Size(min = 1, max = 120) String displayName,
      @Nullable @Pattern(regexp = DECIMAL) String highValueThresholdUsd,
      @Nullable List<@NotNull @Pattern(regexp = "^[A-Z]{2}$") String> highRiskCountries,
      @Nullable Boolean demoMode,
      @Nullable @Min(30) @Max(3650) Integer retentionDays) {}

  /** UpdateTenantStatusInput (FR-TEN-02/03). */
  public record UpdateTenantStatus(
      @NotNull UUID tenantId,
      @NotNull TenantStatus status,
      @NotNull @Size(min = 1, max = 500) String reason) {}

  /** CreateUserInput (FR-TEN-04). The password never appears in toString or logs. */
  public record CreateUser(
      @NotNull @Size(min = 3, max = 320) String email,
      @NotNull @Size(min = 1) String displayName,
      @NotNull @Size(min = 1) List<@NotNull String> roles,
      @NotNull String initialPassword) {
    @Override
    public String toString() {
      return "CreateUser[email=<redacted>, displayName=" + displayName + ", roles=" + roles + "]";
    }

    /** Idempotency fingerprint without the password (the body hash must not encode a secret). */
    List<Object> fingerprint() {
      return List.of(email, displayName, roles);
    }
  }

  /** ListUsersQuery (FR-TEN-05). */
  public record ListUsers(
      @Nullable @Min(1) @Max(100) Integer limit,
      @Nullable @Size(max = 1024) @Pattern(regexp = "^[A-Za-z0-9_-]+$") String cursor,
      @Nullable String role,
      @Nullable UserStatus status) {}

  /** UpdateUserInput (FR-TEN-05): at least one of displayName, roles, status. */
  public record UpdateUser(
      @NotNull UUID userId,
      @Nullable @Size(min = 1) String displayName,
      @Nullable @Size(min = 1) List<@NotNull String> roles,
      @Nullable UserStatus status) {}
}
