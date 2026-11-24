// Redis client with the `files` ACL user (§5.7.3: keys `upload:*`, `file:*`, `quota:files:*`).
import { Redis } from "ioredis";
import type { Config } from "../config.js";

export const KEY_PREFIX = "upload:";

export async function connectRedis(config: Config): Promise<Redis> {
  const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  redis.on("error", () => undefined); // surfaced through readiness, never crashes the process
  await redis.connect();
  return redis;
}

/** Readiness: a key lookup inside the ACL prefix (service users have no @connection, so no PING). */
export function redisCheck(redis: Redis): () => Promise<void> {
  return async () => {
    await redis.exists(`${KEY_PREFIX}readiness-probe`);
  };
}
