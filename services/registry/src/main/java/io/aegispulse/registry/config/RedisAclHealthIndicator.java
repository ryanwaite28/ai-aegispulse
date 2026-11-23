package io.aegispulse.registry.config;

import org.springframework.boot.health.contributor.AbstractHealthIndicator;
import org.springframework.boot.health.contributor.Health;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

/**
 * Readiness for Redis under the registry ACL user (keys {@code auth:*}, {@code ratelimit:auth:*}
 * only; no {@code @connection}, so no PING): a key lookup inside the granted prefix proves
 * reachability and credentials. Bean name yields the health contributor "redisAcl" (readiness
 * group).
 */
@Component("redisAclHealthIndicator")
public class RedisAclHealthIndicator extends AbstractHealthIndicator {
  static final String PROBE_KEY = "auth:readiness-probe";
  private final StringRedisTemplate redis;

  public RedisAclHealthIndicator(StringRedisTemplate redis) {
    super("redis readiness check failed");
    this.redis = redis;
  }

  @Override
  protected void doHealthCheck(Health.Builder builder) {
    redis.hasKey(PROBE_KEY);
    builder.up();
  }
}
