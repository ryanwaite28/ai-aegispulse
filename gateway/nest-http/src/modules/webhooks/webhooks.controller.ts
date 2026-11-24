// POST /webhooks/{sourceKey} (FR-WHK-02): public; the publisher authenticates with HMAC, verified by ingestion.
// Transport only: forward the raw bytes (never re-serialized), the three signature headers, receive time and client
// IP to ingestion.ingestWebhookDelivery with the gateway's own SERVICE token (§5.7.4).
import { Controller, Headers, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { DomainError } from "@aegispulse/ts-platform/errors";
import { INGESTION } from "../../config.js";
import type { IngestionClient, IngestionSchemas } from "../../clients/ingestion.client.js";
import { Public } from "../../common/guards/jwt-auth.guard.js";
import { success, type Success } from "../../common/mappers/envelope.js";

type H = Record<string, string | string[] | undefined>;
const SOURCE_KEY = /^[a-z0-9-]{3,60}$/;

const header = (headers: H, name: string): string | undefined => {
  const v = headers[name];
  return Array.isArray(v) ? v.join(",") : v;
};

@Public()
@Controller("webhooks")
export class WebhooksController {
  constructor(@Inject(INGESTION) private readonly ingestion: IngestionClient) {}

  @Post(":sourceKey")
  @HttpCode(202)
  async submit(
    @Param("sourceKey") sourceKey: string,
    @Headers() headers: H,
    @Req() request: { body: unknown; ip: string },
  ): Promise<Success<IngestionSchemas["WebhookAccepted"]>> {
    if (!SOURCE_KEY.test(sourceKey)) throw new DomainError("WEBHOOK_SOURCE_NOT_FOUND", "unknown webhook source");
    if (!Buffer.isBuffer(request.body)) throw new DomainError("BAD_REQUEST", "content type must be application/json");
    const signature = header(headers, "x-aegis-signature");
    const timestamp = header(headers, "x-aegis-timestamp");
    const deliveryId = header(headers, "x-aegis-delivery-id");
    const r = await this.ingestion.callAsGateway<"ingestWebhookDelivery", IngestionSchemas["WebhookAccepted"]>(
      "ingestWebhookDelivery",
      {
        sourceKey,
        headers: {
          ...(signature === undefined ? {} : { "X-Aegis-Signature": signature }),
          ...(timestamp === undefined ? {} : { "X-Aegis-Timestamp": timestamp }),
          ...(deliveryId === undefined ? {} : { "X-Aegis-Delivery-Id": deliveryId }),
        },
        rawBodyBase64: request.body.toString("base64"),
        receivedAt: new Date().toISOString(),
        clientIp: request.ip,
      },
    );
    return success(r.data);
  }
}
