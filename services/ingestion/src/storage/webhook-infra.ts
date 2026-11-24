// Infrastructure adapters for the ingest use case's ports: Redis nonces (§7.7 whk:nonce:*), raw objects (§7.8
// raw/webhooks/…), tenant status (registry getTenantSettings via the kit's ≤ 60 s cache, FR-TEN-08).
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { TenantSettingsCache } from "@aegispulse/ts-platform/tenant-settings";
import type { Redis } from "ioredis";
import type { NonceStore, RawStore, TenantStatusPort } from "../service/orchestrators/ingest-webhook.usecase.js";

export class RedisNonceStore implements NonceStore {
  constructor(private readonly redis: Redis) {}

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    return (await this.redis.set(key, "1", "EX", ttlSeconds, "NX")) === "OK";
  }
}

export class S3RawStore implements RawStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  async put(key: string, body: Buffer, sha256: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: "application/json",
        ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
      }),
    );
  }
}

export class RegistryTenantStatus implements TenantStatusPort {
  constructor(private readonly settings: TenantSettingsCache) {}

  async isActive(tenantId: string): Promise<boolean> {
    return (await this.settings.get(tenantId)).status === "ACTIVE";
  }
}
