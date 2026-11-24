// Infrastructure adapters for the ingest use case's ports: Redis nonces (§7.7 whk:nonce:*), raw objects (§7.8
// raw/webhooks/…), tenant status (registry getTenantSettings via the kit's ≤ 60 s cache, FR-TEN-08).
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { TenantSettingsCache } from "@aegispulse/ts-platform/tenant-settings";
import type { Redis } from "ioredis";
import type { NonceStore, RawStore, TenantStatusPort } from "../service/orchestrators/ingest-webhook.usecase.js";
import type { RawObject, RawObjectSweeper } from "../service/webhook-maintenance.service.js";

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

/** FR-WHK-08: lists and deletes under raw/webhooks/ only (the identity's List/Write grant is prefix-scoped). */
export class S3RawSweeper implements RawObjectSweeper {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  async *list(prefix: string): AsyncIterable<readonly RawObject[]> {
    if (!prefix.startsWith("raw/webhooks/")) throw new Error("sweep is limited to raw/webhooks/");
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token }),
      );
      yield (page.Contents ?? []).flatMap((o) =>
        o.Key === undefined || o.LastModified === undefined ? [] : [{ key: o.Key, lastModified: o.LastModified }],
      );
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
  }

  async delete(keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const r = await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
        }),
      );
      if ((r.Errors ?? []).length > 0) throw new Error(`raw object delete failed for ${String(r.Errors?.length)} keys`);
    }
  }
}

export class RegistryTenantStatus implements TenantStatusPort {
  constructor(private readonly settings: TenantSettingsCache) {}

  async isActive(tenantId: string): Promise<boolean> {
    return (await this.settings.get(tenantId)).status === "ACTIVE";
  }
}
