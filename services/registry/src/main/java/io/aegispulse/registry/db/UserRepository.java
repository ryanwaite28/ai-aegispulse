package io.aegispulse.registry.db;

import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.registry.domain.Role;
import io.aegispulse.registry.domain.User;
import io.aegispulse.registry.domain.UserStatus;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * registry.users + user_roles under tenant RLS: callers apply TenantScope first, so every query
 * sees only the current tenant (cross-tenant ids read as absent → 404, FR-AUTH-06).
 */
@Repository
public class UserRepository {
  private static final String SELECT =
      "SELECT u.id, u.tenant_id, u.email::text AS email, u.display_name, u.status, u.must_change_password,"
          + " u.last_login_at, u.created_at, u.updated_at,"
          + " ARRAY(SELECT r.role FROM registry.user_roles r WHERE r.user_id = u.id ORDER BY r.role) AS roles"
          + " FROM registry.users u";

  private final JdbcClient jdbc;

  public UserRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  /** Keyset position for listUsers: (created_at, id). */
  public record Position(OffsetDateTime createdAt, UUID id) {}

  public UUID insert(
      UUID tenantId,
      String email,
      String displayName,
      String passwordHash,
      Set<Role> roles,
      @Nullable UUID grantedBy) {
    UUID id;
    try {
      id =
          jdbc.sql(
                  "INSERT INTO registry.users (tenant_id, email, display_name, password_hash, must_change_password)"
                      + " VALUES (?, ?, ?, ?, TRUE) RETURNING id")
              .params(tenantId, email, displayName, passwordHash)
              .query(UUID.class)
              .single();
    } catch (DuplicateKeyException e) {
      throw new DomainException.Conflict(
          "USER_EMAIL_TAKEN", "a user with this email already exists in the tenant");
    }
    insertRoles(tenantId, id, roles, grantedBy);
    return id;
  }

  public Optional<User> findById(UUID id) {
    return jdbc.sql(SELECT + " WHERE u.id = ?").param(id).query(UserRepository::map).optional();
  }

  public List<User> list(
      @Nullable Role role, @Nullable UserStatus status, @Nullable Position after, int limit) {
    StringBuilder sql = new StringBuilder(SELECT).append(" WHERE TRUE");
    List<Object> params = new ArrayList<>();
    if (role != null) {
      sql.append(
          " AND EXISTS (SELECT 1 FROM registry.user_roles r WHERE r.user_id = u.id AND r.role = ?)");
      params.add(role.name());
    }
    if (status != null) {
      sql.append(" AND u.status = ?");
      params.add(status.name());
    }
    if (after != null) {
      sql.append(" AND (u.created_at, u.id) > (?, ?)");
      params.add(after.createdAt());
      params.add(after.id());
    }
    sql.append(" ORDER BY u.created_at, u.id LIMIT ?");
    params.add(limit);
    return jdbc.sql(sql.toString()).params(params).query(UserRepository::map).list();
  }

  public void updateDisplayName(UUID id, String displayName) {
    jdbc.sql("UPDATE registry.users SET display_name = ? WHERE id = ?")
        .params(displayName, id)
        .update();
  }

  public void updateStatus(UUID id, UserStatus status) {
    jdbc.sql("UPDATE registry.users SET status = ? WHERE id = ?")
        .params(status.name(), id)
        .update();
  }

  public void replaceRoles(UUID tenantId, UUID userId, Set<Role> roles, @Nullable UUID grantedBy) {
    jdbc.sql("DELETE FROM registry.user_roles WHERE user_id = ?").param(userId).update();
    insertRoles(tenantId, userId, roles, grantedBy);
  }

  /** ACTIVE users holding TENANT_ADMIN in the current tenant, excluding {@code userId}. */
  public int countOtherActiveTenantAdmins(UUID userId) {
    Integer n =
        jdbc.sql(
                "SELECT count(*)::int FROM registry.users u JOIN registry.user_roles r ON r.user_id = u.id"
                    + " WHERE r.role = 'TENANT_ADMIN' AND u.status = 'ACTIVE' AND u.id <> ?")
            .param(userId)
            .query(Integer.class)
            .single();
    return n == null ? 0 : n;
  }

  /**
   * Whether the current tenant (the platform tenant, for FR-TEN-09) has an ACTIVE PLATFORM_ADMIN.
   */
  public boolean anyActivePlatformAdmin() {
    Boolean exists =
        jdbc.sql(
                "SELECT EXISTS (SELECT 1 FROM registry.users u JOIN registry.user_roles r ON r.user_id = u.id"
                    + " WHERE r.role = 'PLATFORM_ADMIN' AND u.status = 'ACTIVE')")
            .query(Boolean.class)
            .single();
    return Boolean.TRUE.equals(exists);
  }

  private void insertRoles(UUID tenantId, UUID userId, Set<Role> roles, @Nullable UUID grantedBy) {
    for (Role role : roles) {
      jdbc.sql(
              "INSERT INTO registry.user_roles (tenant_id, user_id, role, granted_by) VALUES (?, ?, ?, ?)")
          .params(java.util.Arrays.asList(tenantId, userId, role.name(), grantedBy))
          .update();
    }
  }

  static User map(ResultSet rs, int row) throws SQLException {
    Set<Role> roles = EnumSet.noneOf(Role.class);
    for (String r : TenantRepository.textArray(rs.getArray("roles"))) {
      roles.add(Role.valueOf(r));
    }
    return new User(
        rs.getObject("id", UUID.class),
        rs.getObject("tenant_id", UUID.class),
        rs.getString("email"),
        rs.getString("display_name"),
        roles,
        UserStatus.valueOf(rs.getString("status")),
        rs.getBoolean("must_change_password"),
        rs.getObject("last_login_at", OffsetDateTime.class),
        Objects.requireNonNull(rs.getObject("created_at", OffsetDateTime.class)),
        Objects.requireNonNull(rs.getObject("updated_at", OffsetDateTime.class)));
  }
}
