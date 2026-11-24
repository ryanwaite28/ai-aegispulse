// /v1/entities* (FR-ENT-01/02): parse → one registry action → map.
import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { REGISTRY } from "../../config.js";
import type { RegistryClient, RegistrySchemas } from "../../clients/registry.client.js";
import { Operation } from "../../common/guards/jwt-auth.guard.js";
import { success, type Success } from "../../common/mappers/envelope.js";
import { forwardFrom, objectBody, pageQuery, uuidParam } from "../../common/mappers/forward.js";

type H = Record<string, string | string[] | undefined>;
type Entity = RegistrySchemas["Entity"];

@Controller("v1/entities")
export class EntitiesController {
  constructor(@Inject(REGISTRY) private readonly registry: RegistryClient) {}

  @Operation("listEntities")
  @Get()
  async list(@Headers() headers: H, @Query() query: Record<string, unknown>): Promise<Success<Entity[]>> {
    // Public query `type` maps to the internal `entityType` (§8.3 vs ListEntitiesQuery).
    const { type, ...rest } = pageQuery(query);
    const r = await this.registry.call<"listEntities", Entity[]>(
      "listEntities",
      { ...rest, ...(type === undefined ? {} : { entityType: type }) } as RegistrySchemas["ListEntitiesQuery"],
      forwardFrom(headers, { tenant: true }),
    );
    return success(r.data, r.meta.nextCursor);
  }

  @Operation("createEntity")
  @Post()
  @HttpCode(201)
  async create(@Headers() headers: H, @Body() body: unknown): Promise<Success<Entity>> {
    const r = await this.registry.call<"createEntity", Entity>(
      "createEntity",
      objectBody(body) as RegistrySchemas["CreateEntityInput"],
      forwardFrom(headers, { tenant: true, idempotency: true }),
    );
    return success(r.data);
  }

  @Operation("getEntity")
  @Get(":id")
  async get(@Headers() headers: H, @Param("id") id: string): Promise<Success<RegistrySchemas["EntityDetail"]>> {
    const r = await this.registry.call<"getEntity", RegistrySchemas["EntityDetail"]>(
      "getEntity",
      { entityId: uuidParam(id, "id") },
      forwardFrom(headers, { tenant: true }),
    );
    return success(r.data);
  }

  @Operation("updateEntity")
  @Patch(":id")
  async update(@Headers() headers: H, @Param("id") id: string, @Body() body: unknown): Promise<Success<Entity>> {
    const r = await this.registry.call<"updateEntity", Entity>(
      "updateEntity",
      {
        ...(objectBody(body) as Omit<RegistrySchemas["UpdateEntityInput"], "entityId">),
        entityId: uuidParam(id, "id"),
      },
      forwardFrom(headers, { tenant: true, idempotency: true }),
    );
    return success(r.data);
  }

  @Operation("archiveEntity")
  @Delete(":id")
  async archive(@Headers() headers: H, @Param("id") id: string): Promise<Success<Entity>> {
    const r = await this.registry.call<"archiveEntity", Entity>(
      "archiveEntity",
      { entityId: uuidParam(id, "id") },
      forwardFrom(headers, { idempotency: true }),
    );
    return success(r.data);
  }
}
