package io.aegispulse.registry.db;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import org.jspecify.annotations.Nullable;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** registry.signing_keys: public JWK halves and their lifecycle (FR-AUTH-05; platform table). */
@Repository
public class SigningKeyRepository {
  private final JdbcClient jdbc;

  public SigningKeyRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  /** A stored key: kid, public JWK JSON, status and the time it stopped being CURRENT. */
  public record Stored(String kid, String publicJwk, String status, @Nullable Instant retiredAt) {}

  /** Serializes key registration across registry replicas (transaction-scoped). */
  public void lock() {
    jdbc.sql("SELECT pg_advisory_xact_lock(hashtext('registry.signing_keys'))")
        .query()
        .singleValue();
  }

  public Optional<Stored> current() {
    return jdbc.sql(
            "SELECT kid, public_jwk::text AS jwk, status, retired_at FROM registry.signing_keys WHERE status = 'CURRENT'")
        .query((rs, n) -> {
          OffsetDateTime retired = rs.getObject("retired_at", OffsetDateTime.class);
          return new Stored(
              rs.getString("kid"),
              rs.getString("jwk"),
              rs.getString("status"),
              retired == null ? null : retired.toInstant());
        })
        .optional();
  }

  public void demoteCurrent(Instant now) {
    jdbc.sql(
            "UPDATE registry.signing_keys SET status = 'PREVIOUS', retired_at = ? WHERE status = 'CURRENT'")
        .param(at(now))
        .update();
  }

  public void upsertCurrent(String kid, String publicJwk, Instant now) {
    jdbc.sql(
            "INSERT INTO registry.signing_keys (kid, public_jwk, status, activated_at) VALUES (?, ?::jsonb, 'CURRENT', ?)"
                + " ON CONFLICT (kid) DO UPDATE SET public_jwk = EXCLUDED.public_jwk, status = 'CURRENT',"
                + " activated_at = EXCLUDED.activated_at, retired_at = NULL")
        .params(kid, publicJwk, at(now))
        .update();
  }

  /** PREVIOUS keys replaced before {@code cutoff} are no longer published. */
  public int retireReplacedBefore(Instant cutoff) {
    return jdbc.sql(
            "UPDATE registry.signing_keys SET status = 'RETIRED' WHERE status = 'PREVIOUS' AND retired_at < ?")
        .param(at(cutoff))
        .update();
  }

  /**
   * CURRENT plus PREVIOUS keys replaced at or after {@code cutoff} (the 24 h publication window).
   */
  public List<String> publishedJwks(Instant cutoff) {
    return jdbc.sql(
            "SELECT public_jwk::text FROM registry.signing_keys"
                + " WHERE status = 'CURRENT' OR (status = 'PREVIOUS' AND retired_at >= ?)"
                + " ORDER BY (status = 'CURRENT') DESC, retired_at DESC")
        .param(at(cutoff))
        .query((rs, n) -> java.util.Objects.requireNonNull(rs.getString(1)))
        .list();
  }

  private static OffsetDateTime at(Instant instant) {
    return instant.atOffset(ZoneOffset.UTC);
  }
}
