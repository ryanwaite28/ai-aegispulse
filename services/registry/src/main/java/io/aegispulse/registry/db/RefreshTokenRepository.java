package io.aegispulse.registry.db;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * registry.refresh_tokens (FR-AUTH-01/02/03/07). The lookup by hash runs before tenant context via
 * the SECURITY DEFINER {@code registry.refresh_token_lookup} (ADR-0016); every other statement runs
 * under the caller's TenantScope.
 */
@Repository
public class RefreshTokenRepository {
  private final JdbcClient jdbc;

  public RefreshTokenRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  /** What the definer lookup returns for a token hash. */
  public record Lookup(
      UUID id, UUID tenantId, UUID userId, UUID familyId, String status, Instant expiresAt) {}

  public Optional<Lookup> lookup(String tokenSha256) {
    return jdbc.sql("SELECT * FROM registry.refresh_token_lookup(?)")
        .param(tokenSha256)
        .query((rs, n) ->
            new Lookup(
                rs.getObject("id", UUID.class),
                rs.getObject("tenant_id", UUID.class),
                rs.getObject("user_id", UUID.class),
                rs.getObject("family_id", UUID.class),
                rs.getString("status"),
                Objects.requireNonNull(rs.getObject("expires_at", OffsetDateTime.class))
                    .toInstant()))
        .optional();
  }

  public void insert(
      UUID tenantId, UUID userId, UUID familyId, String tokenSha256, Instant expiresAt) {
    jdbc.sql(
            "INSERT INTO registry.refresh_tokens (tenant_id, user_id, family_id, token_sha256, expires_at)"
                + " VALUES (?, ?, ?, ?, ?)")
        .params(tenantId, userId, familyId, tokenSha256, expiresAt.atOffset(ZoneOffset.UTC))
        .update();
  }

  /** ACTIVE → ROTATED; false when the token was no longer ACTIVE (concurrent reuse). */
  public boolean markRotated(UUID id) {
    return jdbc.sql(
                "UPDATE registry.refresh_tokens SET status = 'ROTATED' WHERE id = ? AND status = 'ACTIVE'")
            .param(id)
            .update()
        == 1;
  }

  public int revokeFamily(UUID familyId) {
    return jdbc.sql(
            "UPDATE registry.refresh_tokens SET status = 'REVOKED' WHERE family_id = ? AND status <> 'REVOKED'")
        .param(familyId)
        .update();
  }

  /** Revokes every family of the user except {@code keepFamily} (FR-TEN-05, FR-AUTH-07). */
  public int revokeUser(UUID userId, @Nullable UUID keepFamily) {
    if (keepFamily == null) {
      return jdbc.sql(
              "UPDATE registry.refresh_tokens SET status = 'REVOKED' WHERE user_id = ? AND status <> 'REVOKED'")
          .param(userId)
          .update();
    }
    return jdbc.sql(
            "UPDATE registry.refresh_tokens SET status = 'REVOKED'"
                + " WHERE user_id = ? AND family_id <> ? AND status <> 'REVOKED'")
        .params(userId, keepFamily)
        .update();
  }
}
