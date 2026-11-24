package io.aegispulse.registry.db;

import java.time.Duration;
import java.util.Optional;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Repository;

/**
 * registry's Redis keyspace (§7.7): {@code ratelimit:auth:*}, {@code ratelimit:cc:*} counters and
 * {@code auth:jwks:cache}. The registry ACL user may touch only these prefixes (§5.7.3).
 */
@Repository
public class AuthCacheStore {
  static final String JWKS_KEY = "auth:jwks:cache";

  private final StringRedisTemplate redis;

  public AuthCacheStore(StringRedisTemplate redis) {
    this.redis = redis;
  }

  public long count(String key) {
    String v = redis.opsForValue().get(key);
    return v == null ? 0 : Long.parseLong(v);
  }

  /** INCR; the window starts at the first failure. */
  public long increment(String key, Duration window) {
    Long n = redis.opsForValue().increment(key);
    long value = n == null ? 0 : n;
    if (value == 1) {
      redis.expire(key, window);
    }
    return value;
  }

  public void clear(String key) {
    redis.delete(key);
  }

  public Optional<String> jwks() {
    return Optional.ofNullable(redis.opsForValue().get(JWKS_KEY));
  }

  public void putJwks(String json, Duration ttl) {
    redis.opsForValue().set(JWKS_KEY, json, ttl);
  }

  public void evictJwks() {
    redis.delete(JWKS_KEY);
  }
}
