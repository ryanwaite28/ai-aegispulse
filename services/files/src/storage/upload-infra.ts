// Infrastructure adapters for the upload use cases' ports. Redis keys follow §7.7 (files ACL: upload:*, file:*,
// quota:files:*); the object store uses the `files` identity; tenant status comes from the registry through the kit's
// ≤ 60 s cache (FR-TEN-08).
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3ServiceException,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { TenantSettingsCache } from "@aegispulse/ts-platform/tenant-settings";
import type { Redis } from "ioredis";
import type { ContentType } from "../domain/file.js";
import { INITS_PER_MINUTE } from "../domain/file.js";
import type {
  DedupIndex,
  FileStatusCache,
  InitRateLimiter,
  PresignedPut,
  TenantStatusPort,
  UploadObjectStore,
  UploadSession,
  UploadSessionStore,
} from "../service/file-upload.service.js";

const PUT_SESSION = `
redis.call('HSET', KEYS[1], 'tenantId', ARGV[2], 'uploader', ARGV[3], 'sizeBytes', ARGV[4], 'sha256', ARGV[5], 'storageKey', ARGV[6])
return redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))`;

export class RedisUploadSessions implements UploadSessionStore {
  constructor(private readonly redis: Redis) {}

  /** HSET + EXPIRE in one script (the files ACL user has no MULTI/EXEC; scripts are atomic). */
  async put(fileId: string, s: UploadSession, ttlSeconds: number): Promise<void> {
    await this.redis.eval(
      PUT_SESSION,
      1,
      `upload:session:${fileId}`,
      ttlSeconds,
      s.tenantId,
      s.uploader,
      String(s.sizeBytes),
      s.sha256,
      s.storageKey,
    );
  }

  async get(fileId: string): Promise<UploadSession | undefined> {
    const h = await this.redis.hgetall(`upload:session:${fileId}`);
    if (h["tenantId"] === undefined || h["uploader"] === undefined) return undefined;
    return {
      tenantId: h["tenantId"],
      uploader: h["uploader"],
      sizeBytes: Number(h["sizeBytes"]),
      sha256: h["sha256"] ?? "",
      storageKey: h["storageKey"] ?? "",
    };
  }

  async delete(fileId: string): Promise<void> {
    await this.redis.del(`upload:session:${fileId}`);
  }
}

const RELEASE_IF_EQUAL = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

export class RedisDedupIndex implements DedupIndex {
  constructor(private readonly redis: Redis) {}

  private key(tenantId: string, sha256: string): string {
    return `file:dedup:${tenantId}:${sha256}`;
  }

  async get(tenantId: string, sha256: string): Promise<string | undefined> {
    return (await this.redis.get(this.key(tenantId, sha256))) ?? undefined;
  }

  async set(
    tenantId: string,
    sha256: string,
    fileId: string,
    ttlSeconds: number,
    onlyIfAbsent: boolean,
  ): Promise<void> {
    if (onlyIfAbsent) await this.redis.set(this.key(tenantId, sha256), fileId, "EX", ttlSeconds, "NX");
    else await this.redis.set(this.key(tenantId, sha256), fileId, "EX", ttlSeconds);
  }

  async release(tenantId: string, sha256: string, fileId: string): Promise<void> {
    await this.redis.eval(RELEASE_IF_EQUAL, 1, this.key(tenantId, sha256), fileId);
  }
}

// FR-FILE-03 token bucket: capacity 60, refill 1 token/s, state in a hash with a 120 s TTL (§7.7). The caller's clock
// is passed in (the files ACL user may not run TIME); replica clock skew only nudges the refill slightly.
const TAKE_TOKEN = `
local cap = tonumber(ARGV[1]); local rate = tonumber(ARGV[2]); local now = tonumber(ARGV[3])
local s = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(s[1]) or cap; local ts = tonumber(s[2]) or now
if now > ts then tokens = math.min(cap, tokens + (now - ts) * rate) else now = ts end
local ok = 0
if tokens >= 1 then tokens = tokens - 1; ok = 1 end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('EXPIRE', KEYS[1], 120)
return ok`;

export class RedisInitRateLimiter implements InitRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async take(tenantId: string): Promise<boolean> {
    const ok = await this.redis.eval(
      TAKE_TOKEN,
      1,
      `quota:files:${tenantId}`,
      INITS_PER_MINUTE,
      INITS_PER_MINUTE / 60,
      this.nowMs() / 1000,
    );
    return ok === 1;
  }
}

export class RedisFileStatusCache implements FileStatusCache {
  constructor(private readonly redis: Redis) {}

  async invalidate(fileId: string): Promise<void> {
    await this.redis.del(`file:status:${fileId}`);
  }
}

/**
 * `internal` talks to the object store inside the network; `presigner` is configured with PUBLIC_OBJECTS_URL so the
 * signed host is the one clients reach. Checksum query parameters are off for presigning (WHEN_REQUIRED), or a plain
 * PUT would have to send a matching checksum header.
 */
export class S3UploadStore implements UploadObjectStore {
  constructor(
    private readonly internal: S3Client,
    private readonly presigner: S3Client,
    readonly bucket: string,
  ) {}

  async presignPut(
    key: string,
    contentType: ContentType,
    sizeBytes: number,
    ttlSeconds: number,
  ): Promise<PresignedPut> {
    const url = await getSignedUrl(
      this.presigner,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: sizeBytes }),
      { expiresIn: ttlSeconds, signableHeaders: new Set(["content-type", "content-length"]) },
    );
    return {
      url,
      headers: { "Content-Type": contentType, "Content-Length": String(sizeBytes) },
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }

  async head(key: string): Promise<{ sizeBytes: number } | undefined> {
    try {
      const r = await this.internal.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: Number(r.ContentLength ?? -1) };
    } catch (error: unknown) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.internal.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export class RegistryTenantStatus implements TenantStatusPort {
  constructor(private readonly settings: TenantSettingsCache) {}

  async status(tenantId: string): Promise<string> {
    return (await this.settings.get(tenantId)).status;
  }
}
