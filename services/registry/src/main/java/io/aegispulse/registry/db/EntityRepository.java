package io.aegispulse.registry.db;

import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.registry.domain.Entity;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * registry.entities + entity_aliases under tenant RLS (callers apply TenantScope first). Resolution
 * stages are batched: one statement per stage over {@code unnest(text[])} (FR-ENT-03, p95 ≤ 50 ms).
 */
@Repository
public class EntityRepository {
  private static final String SELECT =
      "SELECT e.id, e.tenant_id, e.name, e.normalized_name, e.entity_type, e.ticker, e.lei, e.country,"
          + " e.archived_at, e.created_at, e.updated_at,"
          + " ARRAY(SELECT a.alias FROM registry.entity_aliases a WHERE a.entity_id = e.id ORDER BY a.alias) AS aliases"
          + " FROM registry.entities e";

  private final JdbcClient jdbc;

  public EntityRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  /** Keyset position (created_at, id). */
  public record Position(OffsetDateTime createdAt, UUID id) {}

  /** One resolved mention: entity id and similarity in [0, 1]. */
  public record Match(UUID entityId, double similarity) {}

  public UUID insert(
      UUID tenantId,
      String name,
      String normalizedName,
      Entity.Type type,
      @Nullable String ticker,
      @Nullable String lei,
      @Nullable String country) {
    try {
      return jdbc.sql(
              "INSERT INTO registry.entities (tenant_id, name, normalized_name, entity_type, ticker, lei, country)"
                  + " VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
          .params(Arrays.asList(tenantId, name, normalizedName, type.name(), ticker, lei, country))
          .query(UUID.class)
          .single();
    } catch (DuplicateKeyException e) {
      throw duplicate();
    }
  }

  public void addAlias(UUID tenantId, UUID entityId, String alias, String normalizedAlias) {
    try {
      jdbc.sql(
              "INSERT INTO registry.entity_aliases (tenant_id, entity_id, alias, normalized_alias) VALUES (?, ?, ?, ?)")
          .params(tenantId, entityId, alias, normalizedAlias)
          .update();
    } catch (DuplicateKeyException e) {
      throw duplicate();
    }
  }

  public int removeAlias(UUID entityId, String normalizedAlias) {
    return jdbc.sql(
            "DELETE FROM registry.entity_aliases WHERE entity_id = ? AND normalized_alias = ?")
        .params(entityId, normalizedAlias)
        .update();
  }

  public Optional<Entity> findById(UUID id) {
    return jdbc.sql(SELECT + " WHERE e.id = ?").param(id).query(EntityRepository::map).optional();
  }

  /** Locks the row for read-modify-write updates. */
  public Optional<Entity> lockById(UUID id) {
    Optional<UUID> locked =
        jdbc.sql("SELECT id FROM registry.entities WHERE id = ? FOR UPDATE")
            .param(id)
            .query(UUID.class)
            .optional();
    return locked.isEmpty() ? Optional.empty() : findById(id);
  }

  public void update(
      UUID id,
      String name,
      String normalizedName,
      Entity.Type type,
      @Nullable String ticker,
      @Nullable String lei,
      @Nullable String country) {
    try {
      jdbc.sql(
              "UPDATE registry.entities SET name = ?, normalized_name = ?, entity_type = ?, ticker = ?, lei = ?, country = ?"
                  + " WHERE id = ?")
          .params(Arrays.asList(name, normalizedName, type.name(), ticker, lei, country, id))
          .update();
    } catch (DuplicateKeyException e) {
      throw duplicate();
    }
  }

  public void archive(UUID id) {
    jdbc.sql(
            "UPDATE registry.entities SET archived_at = now() WHERE id = ? AND archived_at IS NULL")
        .param(id)
        .update();
  }

  /** Keyset page of non-archived entities, optionally filtered by type and watchlist. */
  public List<Entity> list(
      Entity.@Nullable Type type, @Nullable UUID watchlistId, @Nullable Position after, int limit) {
    StringBuilder sql = new StringBuilder(SELECT).append(" WHERE e.archived_at IS NULL");
    List<Object> params = new ArrayList<>();
    filters(sql, params, type, watchlistId);
    if (after != null) {
      sql.append(" AND (e.created_at, e.id) > (?, ?)");
      params.add(after.createdAt());
      params.add(after.id());
    }
    sql.append(" ORDER BY e.created_at, e.id LIMIT ?");
    params.add(limit);
    return jdbc.sql(sql.toString()).params(params).query(EntityRepository::map).list();
  }

  /**
   * Ranked search: best trigram similarity of name or alias to {@code normalizedQuery}, ties by id.
   */
  public List<Entity> search(
      String normalizedQuery, Entity.@Nullable Type type, @Nullable UUID watchlistId, int limit) {
    StringBuilder sql =
        new StringBuilder("SELECT s.* FROM (")
            .append(SELECT.replace(" FROM registry.entities e", ","))
            .append(
                " GREATEST(similarity(e.normalized_name, ?), COALESCE((SELECT max(similarity(a.normalized_alias, ?))"
                    + " FROM registry.entity_aliases a WHERE a.entity_id = e.id), 0)) AS score"
                    + " FROM registry.entities e WHERE e.archived_at IS NULL");
    List<Object> params = new ArrayList<>(List.of(normalizedQuery, normalizedQuery));
    filters(sql, params, type, watchlistId);
    sql.append(") s WHERE s.score > 0 ORDER BY s.score DESC, s.id LIMIT ?");
    params.add(limit);
    return jdbc.sql(sql.toString()).params(params).query(EntityRepository::map).list();
  }

  private static void filters(
      StringBuilder sql,
      List<Object> params,
      Entity.@Nullable Type type,
      @Nullable UUID watchlistId) {
    if (type != null) {
      sql.append(" AND e.entity_type = ?");
      params.add(type.name());
    }
    if (watchlistId != null) {
      sql.append(
          " AND EXISTS (SELECT 1 FROM registry.watchlist_entries w WHERE w.entity_id = e.id AND w.watchlist_id = ?)");
      params.add(watchlistId);
    }
  }

  // ── FR-ENT-03 resolution stages (non-archived entities only) ────────────────────────────────

  /** TICKER_EXACT: values that equal an entity ticker. */
  public Map<String, Match> byTicker(List<String> values) {
    return stage(
        "SELECT DISTINCT ON (m.v) m.v, e.id, 1.0::float8 AS sim FROM unnest(?::text[]) AS m(v)"
            + " JOIN registry.entities e ON e.ticker = m.v AND e.archived_at IS NULL ORDER BY m.v, e.id",
        values);
  }

  /** ALIAS_EXACT: normalized values that equal an alias. */
  public Map<String, Match> byAlias(List<String> normalized) {
    return stage(
        "SELECT DISTINCT ON (m.v) m.v, e.id, 1.0::float8 AS sim FROM unnest(?::text[]) AS m(v)"
            + " JOIN registry.entity_aliases a ON a.normalized_alias = m.v"
            + " JOIN registry.entities e ON e.id = a.entity_id AND e.archived_at IS NULL ORDER BY m.v, e.id",
        normalized);
  }

  /** NAME_NORMALIZED: normalized values that equal an entity's normalized name. */
  public Map<String, Match> byNormalizedName(List<String> normalized) {
    return stage(
        "SELECT DISTINCT ON (m.v) m.v, e.id, 1.0::float8 AS sim FROM unnest(?::text[]) AS m(v)"
            + " JOIN registry.entities e ON e.normalized_name = m.v AND e.archived_at IS NULL ORDER BY m.v, e.id",
        normalized);
  }

  /** TRIGRAM: best similarity ≥ threshold over names and aliases (GIN-indexed {@code %}). */
  public Map<String, Match> byTrigram(List<String> normalized, double threshold) {
    jdbc.sql("SELECT set_config('pg_trgm.similarity_threshold', ?, true)")
        .param(Double.toString(threshold))
        .query()
        .singleValue();
    return stage(
        "SELECT DISTINCT ON (c.v) c.v, c.id, c.sim FROM ("
            + " SELECT m.v, e.id, similarity(e.normalized_name, m.v)::float8 AS sim FROM unnest(?::text[]) AS m(v)"
            + "   JOIN registry.entities e ON e.normalized_name % m.v AND e.archived_at IS NULL"
            + " UNION ALL"
            + " SELECT m.v, e.id, similarity(a.normalized_alias, m.v)::float8 FROM unnest(?::text[]) AS m(v)"
            + "   JOIN registry.entity_aliases a ON a.normalized_alias % m.v"
            + "   JOIN registry.entities e ON e.id = a.entity_id AND e.archived_at IS NULL"
            + ") c WHERE c.sim >= ? ORDER BY c.v, c.sim DESC, c.id",
        normalized, threshold);
  }

  private Map<String, Match> stage(String sql, List<String> values, Object... extra) {
    Map<String, Match> out = new LinkedHashMap<>();
    if (values.isEmpty()) {
      return out;
    }
    String[] array = values.toArray(String[]::new); // PgJDBC binds String[] as an array
    long arrays = sql.chars().filter(ch -> ch == '?').count() - extra.length;
    List<Object> params = new ArrayList<>();
    for (int i = 0; i < arrays; i++) {
      params.add(array);
    }
    params.addAll(Arrays.asList(extra));
    jdbc.sql(sql)
        .params(params)
        .query((ResultSet rs) -> {
          out.put(
              rs.getString(1),
              new Match(Objects.requireNonNull(rs.getObject(2, UUID.class)), rs.getDouble(3)));
        });
    return out;
  }

  static DomainException duplicate() {
    return new DomainException.Conflict(
        "ENTITY_DUPLICATE", "an entity with this normalized name or alias already exists");
  }

  static Entity map(ResultSet rs, int row) throws SQLException {
    return new Entity(
        rs.getObject("id", UUID.class),
        rs.getObject("tenant_id", UUID.class),
        rs.getString("name"),
        rs.getString("normalized_name"),
        Entity.Type.valueOf(rs.getString("entity_type")),
        rs.getString("ticker"),
        rs.getString("lei"),
        rs.getString("country"),
        TenantRepository.textArray(rs.getArray("aliases")),
        rs.getObject("archived_at", OffsetDateTime.class),
        Objects.requireNonNull(rs.getObject("created_at", OffsetDateTime.class)),
        Objects.requireNonNull(rs.getObject("updated_at", OffsetDateTime.class)));
  }
}
