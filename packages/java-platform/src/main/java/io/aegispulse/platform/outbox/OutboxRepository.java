package io.aegispulse.platform.outbox;

import io.aegispulse.contracts.envelope.CanonicalEnvelope;
import io.aegispulse.platform.db.SqlIdentifiers;
import java.util.List;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.springframework.jdbc.core.simple.JdbcClient;
import tools.jackson.databind.json.JsonMapper;

/**
 * Transactional outbox (PROJECT.md §6.6, §7.0, ADR-0004). {@link #enqueue} joins the caller's
 * transaction, so the event commits atomically with the state change; the relay claims rows with
 * {@code FOR UPDATE SKIP LOCKED}.
 */
public final class OutboxRepository {
  public static final int MAX_ATTEMPTS = 20;
  public static final int MAX_BACKOFF_SECONDS = 300;

  /** A claimed PENDING row. */
  public record Row(
      UUID id, UUID eventId, @Nullable UUID tenantId, OutboxMessage message, int attempts) {}

  private final JdbcClient jdbc;
  private final JsonMapper json;
  private final String table;

  public OutboxRepository(JdbcClient jdbc, JsonMapper json, String schema) {
    this.jdbc = jdbc;
    this.json = json;
    this.table = SqlIdentifiers.table(schema, "outbox_events");
  }

  public static int backoffSeconds(int attempts) {
    return attempts >= 9 ? MAX_BACKOFF_SECONDS : Math.min(1 << attempts, MAX_BACKOFF_SECONDS);
  }

  /**
   * Inserts a PENDING row in the current transaction; a duplicate eventId is a no-op. Returns true
   * if inserted.
   */
  public boolean enqueue(OutboxMessage message) {
    CanonicalEnvelope e = message.envelope();
    int rows =
        jdbc.sql(
                "INSERT INTO "
                    + table
                    + " (tenant_id, event_id, exchange, routing_key, envelope)"
                    + " VALUES (:tenant::uuid, :event::uuid, :exchange, :routingKey, :envelope::jsonb)"
                    + " ON CONFLICT (event_id) DO NOTHING")
            .param("tenant", e.tenantId())
            .param("event", e.eventId())
            .param("exchange", message.exchange())
            .param("routingKey", message.routingKey())
            .param("envelope", json.writeValueAsString(e))
            .update();
    return rows == 1;
  }

  public List<Row> claimBatch(int limit) {
    return jdbc.sql(
            "SELECT id, event_id, tenant_id, exchange, routing_key, envelope::text AS envelope, attempts FROM "
                + table
                + " WHERE status = 'PENDING' AND available_at <= now() ORDER BY available_at LIMIT ?"
                + " FOR UPDATE SKIP LOCKED")
        .param(limit)
        .query((rs, n) ->
            new Row(
                rs.getObject("id", UUID.class),
                rs.getObject("event_id", UUID.class),
                rs.getObject("tenant_id", UUID.class),
                new OutboxMessage(
                    rs.getString("exchange"),
                    rs.getString("routing_key"),
                    json.readValue(rs.getString("envelope"), CanonicalEnvelope.class)),
                rs.getInt("attempts")))
        .list();
  }

  public void markSent(List<UUID> ids) {
    if (ids.isEmpty()) {
      return;
    }
    jdbc.sql(
            "UPDATE "
                + table
                + " SET status = 'SENT', sent_at = now(), last_error = NULL WHERE id = ANY(?)")
        .param(ids.toArray(UUID[]::new))
        .update();
  }

  /**
   * Records a failed publish: backs off 2^attempts s (cap 5 min), FAILED after 20 attempts. Returns
   * the new status.
   */
  public String markFailed(Row row, String error) {
    int attempts = row.attempts() + 1;
    String status = attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING";
    jdbc.sql(
            "UPDATE "
                + table
                + " SET attempts = ?, status = ?, last_error = ?, available_at = now() + make_interval(secs => ?)"
                + " WHERE id = ?")
        .params(
            attempts,
            status,
            error.length() > 1000 ? error.substring(0, 1000) : error,
            backoffSeconds(attempts),
            row.id())
        .update();
    return status;
  }

  public int purgeSent(int days) {
    return jdbc.sql(
            "DELETE FROM "
                + table
                + " WHERE status = 'SENT' AND sent_at < now() - make_interval(days => ?)")
        .param(days)
        .update();
  }

  /** Age in seconds of the oldest PENDING row (0 when none). */
  public double lagSeconds() {
    Double lag =
        jdbc.sql(
                "SELECT EXTRACT(EPOCH FROM (now() - min(created_at)))::float8 FROM "
                    + table
                    + " WHERE status = 'PENDING'")
            .query(Double.class)
            .optional()
            .orElse(null);
    return lag == null ? 0 : Math.max(0, lag);
  }
}
