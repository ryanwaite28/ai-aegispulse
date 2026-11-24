// Infrastructure for the validation consumer's ports: the raw object (files identity: raw/* read+write, quarantine/*
// write), the server-side quarantine move (§7.8 quarantine/{tenantId}/{fileId}), and the tenant slug for N-03.
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  S3ServiceException,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { TenantSettingsCache } from "@aegispulse/ts-platform/tenant-settings";
import type { TenantSlugPort, ValidationObjectStore } from "../service/file-validation.service.js";

const notFound = (e: unknown): boolean =>
  e instanceof NoSuchKey || (e instanceof S3ServiceException && e.$metadata.httpStatusCode === 404);

export class S3ValidationStore implements ValidationObjectStore {
  constructor(
    private readonly s3: S3Client,
    private readonly rawBucket: string,
    private readonly quarantineBucket: string,
  ) {}

  async read(key: string): Promise<AsyncIterable<Uint8Array> | undefined> {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.rawBucket, Key: key }));
      return r.Body as AsyncIterable<Uint8Array> | undefined;
    } catch (error: unknown) {
      if (notFound(error)) return undefined;
      throw error;
    }
  }

  async quarantine(rawKey: string, tenantId: string, fileId: string): Promise<{ bucket: string; key: string }> {
    const key = `quarantine/${tenantId}/${fileId}`;
    await this.s3.send(
      new CopyObjectCommand({
        Bucket: this.quarantineBucket,
        Key: key,
        CopySource: `${this.rawBucket}/${rawKey.split("/").map(encodeURIComponent).join("/")}`,
      }),
    );
    return { bucket: this.quarantineBucket, key };
  }

  async deleteRaw(key: string): Promise<void> {
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.rawBucket, Key: key }));
    } catch (error: unknown) {
      if (!notFound(error)) throw error;
    }
  }
}

export class RegistryTenantSlug implements TenantSlugPort {
  constructor(private readonly settings: TenantSettingsCache) {}

  async slug(tenantId: string): Promise<string> {
    return (await this.settings.get(tenantId)).slug;
  }
}
