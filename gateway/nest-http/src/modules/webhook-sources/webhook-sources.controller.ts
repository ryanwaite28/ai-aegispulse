// /v1/webhook-sources* (FR-WHK-01/07): TENANT_ADMIN. The signing secret appears only in create/rotate responses.
import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { INGESTION } from "../../config.js";
import type { components as CommonApi } from "@aegispulse/contracts/generated/ts/openapi/common.ts";
import type { IngestionClient, IngestionSchemas } from "../../clients/ingestion.client.js";
import { Operation } from "../../common/guards/jwt-auth.guard.js";
import { success, type Success } from "../../common/mappers/envelope.js";
import { forwardFrom, objectBody, pageQuery, uuidParam } from "../../common/mappers/forward.js";

type H = Record<string, string | string[] | undefined>;
type Source = IngestionSchemas["WebhookSource"];
type CommonSchemas = CommonApi["schemas"];

@Controller("v1/webhook-sources")
export class WebhookSourcesController {
  constructor(@Inject(INGESTION) private readonly ingestion: IngestionClient) {}

  @Operation("listWebhookSources")
  @Get()
  async list(@Headers() headers: H, @Query() query: Record<string, unknown>): Promise<Success<Source[]>> {
    const r = await this.ingestion.call<"listWebhookSources", Source[]>(
      "listWebhookSources",
      pageQuery(query) as CommonSchemas["PageQuery"],
      forwardFrom(headers),
    );
    return success(r.data, r.meta.nextCursor);
  }

  @Operation("createWebhookSource")
  @Post()
  @HttpCode(201)
  async create(
    @Headers() headers: H,
    @Body() body: unknown,
  ): Promise<Success<IngestionSchemas["WebhookSourceWithSecret"]>> {
    const r = await this.ingestion.call<"createWebhookSource", IngestionSchemas["WebhookSourceWithSecret"]>(
      "createWebhookSource",
      objectBody(body) as IngestionSchemas["CreateWebhookSourceInput"],
      forwardFrom(headers, { idempotency: true }),
    );
    return success(r.data);
  }

  @Operation("updateWebhookSource")
  @Patch(":id")
  async update(@Headers() headers: H, @Param("id") id: string, @Body() body: unknown): Promise<Success<Source>> {
    const r = await this.ingestion.call<"updateWebhookSource", Source>(
      "updateWebhookSource",
      {
        ...(objectBody(body) as Omit<IngestionSchemas["UpdateWebhookSourceInput"], "sourceId">),
        sourceId: uuidParam(id, "id"),
      },
      forwardFrom(headers, { idempotency: true }),
    );
    return success(r.data);
  }

  @Operation("rotateWebhookSecret")
  @Post(":id/rotate-secret")
  @HttpCode(200)
  async rotate(
    @Headers() headers: H,
    @Param("id") id: string,
  ): Promise<Success<IngestionSchemas["WebhookSecretRotation"]>> {
    const r = await this.ingestion.call<"rotateWebhookSecret", IngestionSchemas["WebhookSecretRotation"]>(
      "rotateWebhookSecret",
      { sourceId: uuidParam(id, "id") },
      forwardFrom(headers, { idempotency: true }),
    );
    return success(r.data);
  }

  @Operation("deleteWebhookSource")
  @Delete(":id")
  async remove(@Headers() headers: H, @Param("id") id: string): Promise<Success<unknown>> {
    const r = await this.ingestion.call(
      "deleteWebhookSource",
      { sourceId: uuidParam(id, "id") },
      forwardFrom(headers, { idempotency: true }),
    );
    return success(r.data);
  }
}
