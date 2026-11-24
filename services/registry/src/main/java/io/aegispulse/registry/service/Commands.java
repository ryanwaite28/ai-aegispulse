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

  /** LoginInput (FR-AUTH-01). */
  public record Login(
      @NotNull @Pattern(regexp = "^[a-z0-9-]{3,40}$") String tenantSlug,
      @NotNull @Size(min = 3, max = 320) String email,
      @NotNull @Size(min = 1, max = 256) String password) {
    @Override
    public String toString() {
      return "Login[tenantSlug=" + tenantSlug + ", <redacted>]";
    }
  }

  /** RefreshTokenInput / LogoutInput (FR-AUTH-02/03). */
  public record RefreshToken(@NotNull @Size(min = 1, max = 512) String refreshToken) {
    @Override
    public String toString() {
      return "RefreshToken[<redacted>]";
    }
  }

  /** ChangePasswordInput (FR-AUTH-07); {@code refreshToken} names the session to keep. */
  public record ChangePassword(
      @NotNull @Size(min = 1, max = 256) String currentPassword,
      @NotNull String newPassword,
      @Nullable @Size(min = 1, max = 512) String refreshToken) {
    @Override
    public String toString() {
      return "ChangePassword[<redacted>]";
    }
  }

  /** IssueClientCredentialsTokenInput (FR-AUTH-04). */
  public record IssueClientCredentials(
      @NotNull @Size(min = 1, max = 100) String clientId,
      @NotNull @Size(min = 1, max = 512) String clientSecret,
      @NotNull @Pattern(regexp = "^(aegispulse|aegispulse-internal)$") String audience) {
    @Override
    public String toString() {
      return "IssueClientCredentials[clientId=" + clientId + ", <redacted>]";
    }
  }

  /** CreateServiceAccountInput (FR-TEN-06). */
  public record CreateServiceAccount(@NotNull @Size(min = 1, max = 200) String name) {}

  /** ListServiceAccountsQuery (FR-TEN-06). */
  public record ListServiceAccounts(
      @Nullable @Min(1) @Max(100) Integer limit,
      @Nullable @Size(max = 1024) @Pattern(regexp = "^[A-Za-z0-9_-]+$") String cursor,
      io.aegispulse.registry.domain.ServiceAccount.@Nullable Status status) {}

  /** {serviceAccountId} for rotate / revoke (FR-TEN-06). */
  public record ServiceAccountRef(@NotNull UUID serviceAccountId) {}

  /** GetTenantSettingsInput (FR-TEN-08). */
  public record GetTenantSettings(@NotNull UUID tenantId) {}

  /** UpdateTenantSettingsInput (FR-TEN-08): at least one setting. */
  public record UpdateTenantSettings(
      @NotNull UUID tenantId,
      @Nullable @Pattern(regexp = DECIMAL) String highValueThresholdUsd,
      @Nullable List<@NotNull @Pattern(regexp = "^[A-Z]{2}$") String> highRiskCountries,
      @Nullable @Min(30) @Max(3650) Integer retentionDays,
      @Nullable Boolean demoMode) {}

  /** CreateEntityInput (FR-ENT-01). */
  public record CreateEntity(
      @NotNull @Size(min = 1, max = 200) String name,
      @NotNull io.aegispulse.registry.domain.Entity.Type entityType,
      @Nullable @Pattern(regexp = "^[A-Z.]{1,10}$") String ticker,
      @Nullable @Pattern(regexp = "^[A-Z0-9]{20}$") String lei,
      @Nullable @Pattern(regexp = "^[A-Z]{2}$") String country,
      @Nullable List<@NotNull @Size(min = 1, max = 200) String> aliases) {}

  /** {entityId} for get / archive. */
  public record EntityRef(@NotNull UUID entityId) {}

  /** ListEntitiesQuery (FR-ENT-02). */
  public record ListEntities(
      @Nullable @Min(1) @Max(100) Integer limit,
      @Nullable @Size(max = 1024) @Pattern(regexp = "^[A-Za-z0-9_-]+$") String cursor,
      @Nullable @Size(min = 1, max = 200) String q,
      io.aegispulse.registry.domain.Entity.@Nullable Type entityType,
      @Nullable UUID watchlistId) {}

  /**
   * UpdateEntityInput (FR-ENT-02). For ticker/lei/country, an absent field leaves the value as is
   * and an explicit null clears it (Optional.empty()).
   */
  public record UpdateEntity(
      @NotNull UUID entityId,
      @Nullable @Size(min = 1, max = 200) String name,
      io.aegispulse.registry.domain.Entity.@Nullable Type entityType,
      java.util.@Nullable Optional<@Pattern(regexp = "^[A-Z.]{1,10}$") String> ticker,
      java.util.@Nullable Optional<@Pattern(regexp = "^[A-Z0-9]{20}$") String> lei,
      java.util.@Nullable Optional<@Pattern(regexp = "^[A-Z]{2}$") String> country,
      @Nullable List<@NotNull @Size(min = 1, max = 200) String> addAliases,
      @Nullable List<@NotNull @Size(min = 1, max = 200) String> removeAliases) {}

  /** ResolveEntitiesInput (FR-ENT-03). */
  public record ResolveEntities(
      @NotNull UUID tenantId,
      @NotNull @Size(max = 500) List<@NotNull @Size(min = 1, max = 500) String> mentions,
      @Nullable @Size(max = 500)
          List<@NotNull @Pattern(regexp = "^[A-Z.]{1,10}$") String> tickers) {}

  static final String SEVERITY = "^(INFO|LOW|MEDIUM|HIGH|CRITICAL)$";

  /** CreateWatchlistInput (FR-ENT-04). */
  public record CreateWatchlist(
      @NotNull @Size(min = 1, max = 200) String name,
      @NotNull @Size(min = 1) String reason,
      @Nullable @Pattern(regexp = SEVERITY) String severityFloor,
      io.aegispulse.registry.domain.Watchlist.@Nullable Status status) {}

  /** ListWatchlistsQuery. */
  public record ListWatchlists(
      @Nullable @Min(1) @Max(100) Integer limit,
      @Nullable @Size(max = 1024) @Pattern(regexp = "^[A-Za-z0-9_-]+$") String cursor) {}

  /** UpdateWatchlistInput: status=PAUSED pauses. */
  public record UpdateWatchlist(
      @NotNull UUID watchlistId,
      @Nullable @Size(min = 1, max = 200) String name,
      @Nullable @Size(min = 1) String reason,
      @Nullable @Pattern(regexp = SEVERITY) String severityFloor,
      io.aegispulse.registry.domain.Watchlist.@Nullable Status status) {}

  /** {watchlistId} for delete. */
  public record WatchlistRef(@NotNull UUID watchlistId) {}

  /** AddWatchlistEntryInput. */
  public record AddWatchlistEntry(
      @NotNull UUID watchlistId, @NotNull UUID entityId, @Nullable @Size(max = 2000) String note) {}

  /** RemoveWatchlistEntryInput. */
  public record RemoveWatchlistEntry(@NotNull UUID watchlistId, @NotNull UUID entityId) {}

  /** CounterpartyRef. */
  public record CounterpartyRef(
      @NotNull @Size(min = 1, max = 64) String counterpartyId,
      @Nullable @Size(min = 1, max = 200) String counterpartyName) {}

  /** CheckWatchlistsInput (FR-ENT-05): entityIds and/or counterpartyRefs. */
  public record CheckWatchlists(
      @NotNull UUID tenantId,
      @Nullable @Size(max = 1000) List<@NotNull UUID> entityIds,
      @Nullable @Size(max = 1000)
          List<@NotNull @jakarta.validation.Valid CounterpartyRef> counterpartyRefs) {}
}
