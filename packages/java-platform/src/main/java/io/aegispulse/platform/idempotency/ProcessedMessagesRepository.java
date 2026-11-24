package io.aegispulse.platform.idempotency;

import io.aegispulse.platform.db.SqlIdentifiers;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * Consumer dedup (NFR-02): {@code processed_messages(consumer, event_id, replay_generation)} marked
 * in the same transaction as the service's state change. A redelivery after commit is detected; a
 * crash before commit retries.
 */
public final class ProcessedMessagesRepository {
  private final JdbcClient jdbc;
  private final String table;

  public ProcessedMessagesRepository(JdbcClient jdbc, String schema) {
    this.jdbc = jdbc;
    this.table = SqlIdentifiers.table(schema, "processed_messages");
  }

  /** Returns false when already processed (the caller skips its work and returns DUPLICATE). */
  public boolean markProcessed(String consumer, UUID eventId, int replayGeneration) {
    return jdbc.sql(
                "INSERT INTO "
                    + table
                    + " (consumer, event_id, replay_generation) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
            .params(consumer, eventId, replayGeneration)
            .update()
        == 1;
  }

  /** 14-day retention. */
  public int purge(int days) {
    return jdbc.sql(
            "DELETE FROM " + table + " WHERE processed_at < now() - make_interval(days => ?)")
        .param(days)
        .update();
  }
}
