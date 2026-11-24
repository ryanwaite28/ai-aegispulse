package io.aegispulse.registry.db;

import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.registry.domain.Watchlist;
import io.aegispulse.registry.domain.WatchlistEntry;
import io.aegispulse.registry.domain.WatchlistMembership;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** registry.watchlists + watchlist_entries under tenant RLS (FR-ENT-04/05). */
@Repository
public class WatchlistRepository {
  private static final String SELECT =
      "SELECT w.id, w.tenant_id, w.name, w.reason, w.severity_floor, w.status, w.created_by, w.created_at,"
          + " w.updated_at, (SELECT count(*)::int FROM registry.watchlist_entries x WHERE x.watchlist_id = w.id)"
          + " AS entry_count FROM registry.watchlists w";

  private final JdbcClient jdbc;

  public WatchlistRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  /** Keyset position (created_at, id). */
  public record Position(OffsetDateTime createdAt, UUID id) {}

  /** A watchlist hit before mapping to counterparty refs (FR-ENT-05). */
  public record Hit(UUID watchlistId, String watchlistName, String severityFloor, UUID entityId) {}

  public UUID insert(
      UUID tenantId,
      String name,
      String reason,
      String severityFloor,
      Watchlist.Status status,
      @Nullable UUID createdBy) {
    try {
      return jdbc.sql(
              "INSERT INTO registry.watchlists (tenant_id, name, reason, severity_floor, status, created_by)"
                  + " VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
          .params(Arrays.asList(tenantId, name, reason, severityFloor, status.name(), createdBy))
          .query(UUID.class)
          .single();
    } catch (DuplicateKeyException e) {
      throw nameTaken();
    }
  }

  public Optional<Watchlist> findActive(UUID id) {
    return jdbc.sql(SELECT + " WHERE w.id = ? AND w.deleted_at IS NULL")
        .param(id)
        .query(WatchlistRepository::map)
        .optional();
  }

  public boolean lockActive(UUID id) {
    return jdbc.sql(
            "SELECT id FROM registry.watchlists WHERE id = ? AND deleted_at IS NULL FOR UPDATE")
        .param(id)
        .query(UUID.class)
        .optional()
        .isPresent();
  }

  public List<Watchlist> list(@Nullable Position after, int limit) {
    StringBuilder sql = new StringBuilder(SELECT).append(" WHERE w.deleted_at IS NULL");
    List<Object> params = new ArrayList<>();
    if (after != null) {
      sql.append(" AND (w.created_at, w.id) > (?, ?)");
      params.add(after.createdAt());
      params.add(after.id());
    }
    sql.append(" ORDER BY w.created_at, w.id LIMIT ?");
    params.add(limit);
    return jdbc.sql(sql.toString()).params(params).query(WatchlistRepository::map).list();
  }

  public void update(
      UUID id, String name, String reason, String severityFloor, Watchlist.Status status) {
    try {
      jdbc.sql(
              "UPDATE registry.watchlists SET name = ?, reason = ?, severity_floor = ?, status = ? WHERE id = ?")
          .params(name, reason, severityFloor, status.name(), id)
          .update();
    } catch (DuplicateKeyException e) {
      throw nameTaken();
    }
  }

  public void softDelete(UUID id) {
    jdbc.sql(
            "UPDATE registry.watchlists SET deleted_at = now() WHERE id = ? AND deleted_at IS NULL")
        .param(id)
        .update();
  }

  /** Insert, or update the note of an existing entry. */
  public WatchlistEntry upsertEntry(
      UUID tenantId,
      UUID watchlistId,
      UUID entityId,
      @Nullable String note,
      @Nullable UUID addedBy) {
    return jdbc.sql(
            "INSERT INTO registry.watchlist_entries (watchlist_id, entity_id, tenant_id, note, added_by)"
                + " VALUES (?, ?, ?, ?, ?) ON CONFLICT (watchlist_id, entity_id) DO UPDATE SET note = EXCLUDED.note"
                + " RETURNING watchlist_id, entity_id, note, added_by, created_at")
        .params(Arrays.asList(watchlistId, entityId, tenantId, note, addedBy))
        .query((rs, n) ->
            new WatchlistEntry(
                rs.getObject("watchlist_id", UUID.class),
                rs.getObject("entity_id", UUID.class),
                rs.getString("note"),
                rs.getObject("added_by", UUID.class),
                Objects.requireNonNull(rs.getObject("created_at", OffsetDateTime.class))))
        .single();
  }

  public int removeEntry(UUID watchlistId, UUID entityId) {
    return jdbc.sql(
            "DELETE FROM registry.watchlist_entries WHERE watchlist_id = ? AND entity_id = ?")
        .params(watchlistId, entityId)
        .update();
  }

  /** Non-deleted watchlists containing the entity (entity detail). */
  public List<WatchlistMembership> memberships(UUID entityId) {
    return jdbc.sql(
            "SELECT w.id, w.name, w.status FROM registry.watchlist_entries x JOIN registry.watchlists w"
                + " ON w.id = x.watchlist_id AND w.deleted_at IS NULL WHERE x.entity_id = ? ORDER BY w.name, w.id")
        .param(entityId)
        .query((rs, n) ->
            new WatchlistMembership(
                rs.getObject("id", UUID.class),
                rs.getString("name"),
                Watchlist.Status.valueOf(rs.getString("status"))))
        .list();
  }

  /**
   * FR-ENT-05: hits on ACTIVE, non-deleted watchlists for non-archived entities, deterministic
   * order.
   */
  public List<Hit> hits(List<UUID> entityIds) {
    if (entityIds.isEmpty()) {
      return List.of();
    }
    return jdbc.sql(
            "SELECT w.id, w.name, w.severity_floor, x.entity_id FROM registry.watchlist_entries x"
                + " JOIN registry.watchlists w ON w.id = x.watchlist_id AND w.deleted_at IS NULL AND w.status = 'ACTIVE'"
                + " JOIN registry.entities e ON e.id = x.entity_id AND e.archived_at IS NULL"
                + " WHERE x.entity_id = ANY(?::uuid[]) ORDER BY w.name, w.id, x.entity_id")
        .param(entityIds.stream().map(UUID::toString).toArray(String[]::new))
        .query((rs, n) ->
            new Hit(
                rs.getObject(1, UUID.class),
                rs.getString(2),
                rs.getString(3),
                rs.getObject(4, UUID.class)))
        .list();
  }

  static DomainException nameTaken() {
    return new DomainException.Conflict(
        "WATCHLIST_NAME_TAKEN", "a watchlist with this name already exists");
  }

  static Watchlist map(ResultSet rs, int row) throws SQLException {
    return new Watchlist(
        rs.getObject("id", UUID.class),
        rs.getObject("tenant_id", UUID.class),
        rs.getString("name"),
        rs.getString("reason"),
        rs.getString("severity_floor"),
        Watchlist.Status.valueOf(rs.getString("status")),
        rs.getInt("entry_count"),
        rs.getObject("created_by", UUID.class),
        Objects.requireNonNull(rs.getObject("created_at", OffsetDateTime.class)),
        Objects.requireNonNull(rs.getObject("updated_at", OffsetDateTime.class)));
  }
}
