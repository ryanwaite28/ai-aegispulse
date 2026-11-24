package io.aegispulse.registry.service;

import io.aegispulse.platform.errors.DomainException;
import io.aegispulse.registry.db.AuthCacheStore;
import io.aegispulse.registry.domain.Secrets;
import java.time.Duration;
import java.util.Locale;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Failed-attempt throttles (§7.7): login 5 per 15 min per (tenant, email) (FR-AUTH-01); client
 * credentials 10 per 5 min per clientId (FR-AUTH-04). Keys carry hashes, never emails or ids.
 */
@Component
class Throttle {
  static final UUID UNKNOWN_TENANT = new UUID(0, 0);
  static final int LOGIN_MAX = 5;
  static final Duration LOGIN_WINDOW = Duration.ofMinutes(15);
  static final int CC_MAX = 10;
  static final Duration CC_WINDOW = Duration.ofMinutes(5);

  private final AuthCacheStore store;

  Throttle(AuthCacheStore store) {
    this.store = store;
  }

  record Key(String value, int max, Duration window) {}

  static Key login(UUID tenantId, String email) {
    return new Key(
        "ratelimit:auth:" + tenantId + ":" + Secrets.sha256Hex(email.toLowerCase(Locale.ROOT)),
        LOGIN_MAX,
        LOGIN_WINDOW);
  }

  static Key clientCredentials(String clientId) {
    return new Key("ratelimit:cc:" + Secrets.sha256Hex(clientId), CC_MAX, CC_WINDOW);
  }

  void check(Key key) {
    if (store.count(key.value()) >= key.max()) {
      throw new DomainException.RateLimited("AUTH_RATE_LIMITED", "too many attempts; try later");
    }
  }

  void fail(Key key) {
    store.increment(key.value(), key.window());
  }

  void clear(Key key) {
    store.clear(key.value());
  }
}
