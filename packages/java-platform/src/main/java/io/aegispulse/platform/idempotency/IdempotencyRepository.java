package io.aegispulse.platform.idempotency;

import io.aegispulse.platform.db.SqlIdentifiers;
import io.aegispulse.platform.errors.DomainException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * HTTP Idempotency-Key store (NFR-02, §7.0): key + request-body SHA-256 + response for 24 h. Use
 * inside a transaction after {@code TenantScope.apply(tenantId)} (the table is under RLS and fails
 * closed otherwise).
 */
public final class IdempotencyRepository {
  private static final Pattern KEY = Pattern.compile("^[\\x21-\\x7e]{1,255}$");

  /**
   * Outcome of {@link #begin}: NEW (do the work, then complete) or REPLAY (return the stored
   * response).
   */
  public sealed interface Decision permits Decision.New, Decision.Replay {
    /** First use of the key (or an expired one). */
    record New() implements Decision {}

    /** Same key and body seen before. */
    record Replay(int status, @Nullable String bodyJson) implements Decision {}
  }

  private final JdbcClient jdbc;
  private final String table;
  private final String purgeFunction;

  public IdempotencyRepository(JdbcClient jdbc, String schema) {
    this.jdbc = jdbc;
    this.table = SqlIdentifiers.table(schema, "idempotency_records");
    this.purgeFunction = SqlIdentifiers.table(schema, "purge_expired_idempotency_records");
  }

  public static String sha256Hex(byte[] body) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(body));
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-256 unavailable", e);
    }
  }

  public static String sha256Hex(String body) {
    return sha256Hex(body.getBytes(StandardCharsets.UTF_8));
  }

  private record Existing(
      String sha, @Nullable Integer status, @Nullable String body, boolean expired) {}

  public Decision begin(UUID tenantId, String scope, String key, String requestSha256) {
    if (!KEY.matcher(key).matches()) {
      throw new DomainException.Validation(
          "VALIDATION_ERROR",
          "invalid Idempotency-Key",
          List.of(
              new DomainException.ErrorDetail(
                  "Idempotency-Key", "1-255 printable ASCII characters")));
    }
    int inserted =
        jdbc.sql(
                "INSERT INTO "
                    + table
                    + " (tenant_id, scope, idempotency_key, request_sha256, expires_at)"
                    + " VALUES (?, ?, ?, ?, now() + interval '24 hours') ON CONFLICT DO NOTHING")
            .params(tenantId, scope, key, requestSha256)
            .update();
    if (inserted == 1) {
      return new Decision.New();
    }
    Optional<Existing> existing =
        jdbc.sql(
                "SELECT request_sha256, response_status, response_body::text AS body, expires_at <= now() AS expired FROM "
                    + table
                    + " WHERE tenant_id = ? AND scope = ? AND idempotency_key = ? FOR UPDATE")
            .params(tenantId, scope, key)
            .query((rs, n) ->
                new Existing(
                    rs.getString("request_sha256"),
                    rs.getObject("response_status", Integer.class),
                    rs.getString("body"),
                    rs.getBoolean("expired")))
            .optional();
    Existing row = existing.orElse(null);
    if (row == null || row.expired() || row.status() == null) {
      jdbc.sql(
              "UPDATE "
                  + table
                  + " SET request_sha256 = ?, response_status = NULL, response_body = NULL,"
                  + " expires_at = now() + interval '24 hours', created_at = now()"
                  + " WHERE tenant_id = ? AND scope = ? AND idempotency_key = ?")
          .params(requestSha256, tenantId, scope, key)
          .update();
      return new Decision.New();
    }
    if (!row.sha().equals(requestSha256)) {
      throw new DomainException.Conflict(
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency-Key was already used with a different request body");
    }
    return new Decision.Replay(row.status(), row.body());
  }

  public void complete(UUID tenantId, String scope, String key, int status, String bodyJson) {
    jdbc.sql(
            "UPDATE "
                + table
                + " SET response_status = ?, response_body = ?::jsonb WHERE tenant_id = ? AND scope = ? AND idempotency_key = ?")
        .params(status, bodyJson, tenantId, scope, key)
        .update();
  }

  /**
   * Cross-tenant retention purge (NFR-02) through the SECURITY DEFINER function owned by {@code
   * {schema}_platform}; a service session cannot lift RLS itself (ADR-0016).
   */
  public int purgeExpired() {
    Integer n = jdbc.sql("SELECT " + purgeFunction + "()").query(Integer.class).single();
    return n == null ? 0 : n;
  }
}
