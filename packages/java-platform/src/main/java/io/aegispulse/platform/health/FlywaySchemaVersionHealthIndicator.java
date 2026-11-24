package io.aegispulse.platform.health;

import io.aegispulse.platform.db.SqlIdentifiers;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import org.jspecify.annotations.Nullable;
import org.springframework.boot.health.contributor.AbstractHealthIndicator;
import org.springframework.boot.health.contributor.Health;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * NFR-11 (c): ready only when the owned schema's newest successful Flyway migration is at or above
 * the version this build expects (svc_* roles can SELECT flyway_schema_history; apps never migrate
 * themselves).
 */
public final class FlywaySchemaVersionHealthIndicator extends AbstractHealthIndicator {
  private static final java.util.regex.Pattern DOT = java.util.regex.Pattern.compile("\\.");
  private final JdbcClient jdbc;
  private final String table;
  private final String minVersion;

  public FlywaySchemaVersionHealthIndicator(JdbcClient jdbc, String schema, String minVersion) {
    super("flyway schema version check failed");
    this.jdbc = jdbc;
    this.table = SqlIdentifiers.table(schema, "flyway_schema_history");
    this.minVersion = minVersion;
  }

  static int compare(String a, String b) {
    long[] pa = DOT.splitAsStream(a).mapToLong(Long::parseLong).toArray();
    long[] pb = DOT.splitAsStream(b).mapToLong(Long::parseLong).toArray();
    for (int i = 0; i < Math.max(pa.length, pb.length); i++) {
      long x = i < pa.length ? pa[i] : 0;
      long y = i < pb.length ? pb[i] : 0;
      if (x != y) {
        return Long.compare(x, y);
      }
    }
    return 0;
  }

  @Override
  protected void doHealthCheck(Health.Builder builder) {
    List<@Nullable String> versions =
        jdbc.sql("SELECT version FROM " + table + " WHERE success AND version IS NOT NULL")
            .query(String.class)
            .list();
    String newest =
        versions.stream()
            .filter(Objects::nonNull)
            .map(Objects::requireNonNull)
            .max(Comparator.comparing(v -> v, FlywaySchemaVersionHealthIndicator::compare))
            .orElse(null);
    if (newest == null) {
      builder.down().withDetail("reason", "no applied migrations");
    } else if (compare(newest, minVersion) < 0) {
      builder.down().withDetail("schemaVersion", newest).withDetail("required", minVersion);
    } else {
      builder.up().withDetail("schemaVersion", newest);
    }
  }
}
