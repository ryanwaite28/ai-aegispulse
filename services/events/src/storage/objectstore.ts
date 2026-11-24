// Object store client with the `events` identity (§5.7.3, ADR-0011); keys are generated server-side only.
import { HeadObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import type { Config } from "../config.js";

export function createObjectStore(config: Config): S3Client {
  return new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY },
    maxAttempts: 2,
  });
}

export function bucketName(config: Config): string {
  return `${config.S3_BUCKET_PREFIX}-archive`;
}

/** Readiness: HEAD a probe key inside this identity's grant. 404 = reachable and authorized; 403/5xx = down. */
export function objectStoreCheck(s3: S3Client, config: Config): () => Promise<void> {
  return async () => {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucketName(config), Key: ".readiness" }));
    } catch (error: unknown) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return;
      throw error;
    }
  };
}
