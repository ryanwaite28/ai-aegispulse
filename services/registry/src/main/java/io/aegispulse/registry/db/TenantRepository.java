package io.aegispulse.registry.db;

import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.registry.domain.Tenant;
import io.aegispulse.registry.domain.TenantStatus;
import java.math.BigDecimal;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** registry.tenants (platform table, no RLS; authorization is in the service layer). */
@Repository
public class TenantRepository {
  private static final String COLUMNS =
      "id, slug, display_name, status, status_reason, high_value_threshold_usd, high_risk_countries,"
          + " retention_days, demo_mode, created_at, updated_at";

  private final JdbcClient jdbc;

  public TenantRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  /** New-tenant values after defaults are applied. */
  public record NewTenant(
      String slug,
      String displayName,
      BigDecimal highValueThresholdUsd,
      List<String> highRiskCountries,
      int retentionDays,
      boolean demoMode) {}

  public Tenant insert(NewTenant t) {
    try {
      return jdbc.sql(
              "INSERT INTO registry.tenants (slug, display_name, high_value_threshold_usd, high_risk_countries,"
                  + " retention_days, demo_mode) VALUES (?, ?, ?, string_to_array(?, ','), ?, ?) RETURNING "
                  + COLUMNS)
          .params(
              t.slug(),
              t.displayName(),
              t.highValueThresholdUsd(),
              String.join(",", t.highRiskCountries()),
              t.retentionDays(),
              t.demoMode())
          .query(TenantRepository::map)
          .single();
    } catch (DuplicateKeyException e) {
      throw new DomainException.Conflict("TENANT_SLUG_TAKEN", "tenant slug is already taken");
    }
  }

  public Optional<Tenant> findById(UUID id) {
    return jdbc.sql("SELECT " + COLUMNS + " FROM registry.tenants WHERE id = ?")
        .param(id)
        .query(TenantRepository::map)
        .optional();
  }

  public Optional<Tenant> findBySlug(String slug) {
    return jdbc.sql("SELECT " + COLUMNS + " FROM registry.tenants WHERE slug = ?")
        .param(slug)
        .query(TenantRepository::map)
        .optional();
  }

  /** Row lock that serializes admin-affecting changes within one tenant (FR-TEN-05, FR-TEN-09). */
  public Optional<Tenant> lockById(UUID id) {
    return jdbc.sql("SELECT " + COLUMNS + " FROM registry.tenants WHERE id = ? FOR UPDATE")
        .param(id)
        .query(TenantRepository::map)
        .optional();
  }

  public Tenant updateSettings(
      UUID id, BigDecimal threshold, List<String> countries, int retentionDays, boolean demoMode) {
    return jdbc.sql(
            "UPDATE registry.tenants SET high_value_threshold_usd = ?, high_risk_countries = string_to_array(?, ','),"
                + " retention_days = ?, demo_mode = ? WHERE id = ? RETURNING "
                + COLUMNS)
        .params(threshold, String.join(",", countries), retentionDays, demoMode, id)
        .query(TenantRepository::map)
        .single();
  }

  public Tenant updateStatus(UUID id, TenantStatus status, String reason) {
    return jdbc.sql(
            "UPDATE registry.tenants SET status = ?, status_reason = ? WHERE id = ? RETURNING "
                + COLUMNS)
        .params(status.name(), reason, id)
        .query(TenantRepository::map)
        .single();
  }

  static Tenant map(ResultSet rs, int row) throws SQLException {
    return new Tenant(
        rs.getObject("id", UUID.class),
        rs.getString("slug"),
        rs.getString("display_name"),
        TenantStatus.valueOf(rs.getString("status")),
        rs.getString("status_reason"),
        rs.getBigDecimal("high_value_threshold_usd"),
        textArray(rs.getArray("high_risk_countries")),
        rs.getInt("retention_days"),
        rs.getBoolean("demo_mode"),
        Objects.requireNonNull(rs.getObject("created_at", OffsetDateTime.class)),
        Objects.requireNonNull(rs.getObject("updated_at", OffsetDateTime.class)));
  }

  static List<String> textArray(@Nullable Array array) throws SQLException {
    if (array == null) {
      return List.of();
    }
    return List.of((String[]) array.getArray());
  }
}
