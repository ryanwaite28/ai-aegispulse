package io.aegispulse.registry.db;

import io.aegispulse.registry.domain.ServiceAccount;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * registry.service_accounts + secrets (FR-TEN-06/07, FR-AUTH-04). Tenant-scoped statements run
 * under RLS; the pre-tenant client-credentials lookup and SERVICE reconciliation use the definer
 * functions from V5 (ADR-0016, ADR-0017).
 */
@Repository
public class ServiceAccountRepository {
  private static final String COLUMNS =
      "id, tenant_id, client_id, name, kind, status, created_at, updated_at";

  private final JdbcClient jdbc;

  public ServiceAccountRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  /** One verifier row of {@code client_credentials_lookup} (secret columns null if none). */
  public record CredentialRow(
      UUID id,
      @Nullable UUID tenantId,
      ServiceAccount.Kind kind,
      List<String> allowedActions,
      ServiceAccount.Status status,
      @Nullable String secretHash,
      @Nullable Instant validUntil) {}

  /** Keyset position (created_at, id). */
  public record Position(OffsetDateTime createdAt, UUID id) {}

  public List<CredentialRow> credentials(String clientId) {
    return jdbc.sql("SELECT * FROM registry.client_credentials_lookup(?)")
        .param(clientId)
        .query((rs, n) -> {
          OffsetDateTime until = rs.getObject("valid_until", OffsetDateTime.class);
          return new CredentialRow(
              rs.getObject("id", UUID.class),
              rs.getObject("tenant_id", UUID.class),
              ServiceAccount.Kind.valueOf(rs.getString("kind")),
              textArray(rs.getArray("allowed_actions")),
              ServiceAccount.Status.valueOf(rs.getString("status")),
              rs.getString("secret_hash"),
              until == null ? null : until.toInstant());
        })
        .list();
  }

  public List<String> serviceClientIds() {
    return jdbc.sql("SELECT * FROM registry.service_client_ids()")
        .query((rs, n) -> Objects.requireNonNull(rs.getString(1)))
        .list();
  }

  /** SERVICE reconciliation: open verifiers get {@code graceUntil}; the new verifier is added. */
  public boolean addServiceSecret(String clientId, String secretHash, Instant graceUntil) {
    Boolean added =
        jdbc.sql("SELECT registry.add_service_account_secret(?, ?, ?)")
            .params(clientId, secretHash, graceUntil.atOffset(ZoneOffset.UTC))
            .query(Boolean.class)
            .single();
    return Boolean.TRUE.equals(added);
  }

  public ServiceAccount insertIntegration(
      UUID tenantId, String clientId, String name, @Nullable UUID createdBy) {
    return jdbc.sql(
            "INSERT INTO registry.service_accounts (tenant_id, client_id, name, kind, created_by)"
                + " VALUES (?, ?, ?, 'INTEGRATION', ?) RETURNING "
                + COLUMNS)
        .params(java.util.Arrays.asList(tenantId, clientId, name, createdBy))
        .query(ServiceAccountRepository::map)
        .single();
  }

  public void insertSecret(UUID accountId, String secretHash) {
    jdbc.sql(
            "INSERT INTO registry.service_account_secrets (service_account_id, secret_hash) VALUES (?, ?)")
        .params(accountId, secretHash)
        .update();
  }

  /** Puts every open-ended verifier of the account on a grace deadline (FR-TEN-06 rotation). */
  public void graceOpenSecrets(UUID accountId, Instant until) {
    jdbc.sql(
            "UPDATE registry.service_account_secrets SET valid_until = ?"
                + " WHERE service_account_id = ? AND (valid_until IS NULL OR valid_until > ?)")
        .params(until.atOffset(ZoneOffset.UTC), accountId, until.atOffset(ZoneOffset.UTC))
        .update();
  }

  public Optional<ServiceAccount> findById(UUID id) {
    return jdbc.sql("SELECT " + COLUMNS + " FROM registry.service_accounts WHERE id = ?")
        .param(id)
        .query(ServiceAccountRepository::map)
        .optional();
  }

  public List<ServiceAccount> list(
      ServiceAccount.@Nullable Status status, @Nullable Position after, int limit) {
    StringBuilder sql =
        new StringBuilder("SELECT " + COLUMNS + " FROM registry.service_accounts WHERE TRUE");
    List<Object> params = new ArrayList<>();
    if (status != null) {
      sql.append(" AND status = ?");
      params.add(status.name());
    }
    if (after != null) {
      sql.append(" AND (created_at, id) > (?, ?)");
      params.add(after.createdAt());
      params.add(after.id());
    }
    sql.append(" ORDER BY created_at, id LIMIT ?");
    params.add(limit);
    return jdbc.sql(sql.toString()).params(params).query(ServiceAccountRepository::map).list();
  }

  public ServiceAccount revoke(UUID id) {
    return jdbc.sql(
            "UPDATE registry.service_accounts SET status = 'REVOKED' WHERE id = ? RETURNING "
                + COLUMNS)
        .param(id)
        .query(ServiceAccountRepository::map)
        .single();
  }

  static ServiceAccount map(ResultSet rs, int row) throws SQLException {
    return new ServiceAccount(
        rs.getObject("id", UUID.class),
        rs.getObject("tenant_id", UUID.class),
        rs.getString("client_id"),
        rs.getString("name"),
        ServiceAccount.Kind.valueOf(rs.getString("kind")),
        ServiceAccount.Status.valueOf(rs.getString("status")),
        Objects.requireNonNull(rs.getObject("created_at", OffsetDateTime.class)),
        Objects.requireNonNull(rs.getObject("updated_at", OffsetDateTime.class)));
  }

  private static List<String> textArray(@Nullable Array array) throws SQLException {
    return TenantRepository.textArray(array);
  }
}
