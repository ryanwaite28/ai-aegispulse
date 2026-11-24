// /v1/service-accounts* (FR-TEN-06): TENANT_ADMIN. Secrets appear only in create/rotate responses, never in logs.
import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { REGISTRY } from "../../config.js";
import type { RegistryClient, RegistrySchemas } from "../../clients/registry.client.js";
import { Operation } from "../../common/guards/jwt-auth.guard.js";
import { success, type Success } from "../../common/mappers/envelope.js";
import { forwardFrom, objectBody, pageQuery, uuidParam } from "../../common/mappers/forward.js";

type H = Record<string, string | string[] | undefined>;
type Account = RegistrySchemas["ServiceAccount"];
type WithSecret = RegistrySchemas["ServiceAccountWithSecret"];

@Controller("v1/service-accounts")
export class ServiceAccountsController {
  constructor(@Inject(REGISTRY) private readonly registry: RegistryClient) {}

  @Operation("listServiceAccounts")
  @Get()
  async list(@Headers() headers: H, @Query() query: Record<string, unknown>): Promise<Success<Account[]>> {
    const r = await this.registry.call<"listServiceAccounts", Account[]>(
      "listServiceAccounts",
      pageQuery(query) as RegistrySchemas["ListServiceAccountsQuery"],
      forwardFrom(headers),
    );
    return success(r.data, r.meta.nextCursor);
  }

  @Operation("createServiceAccount")
  @Post()
  @HttpCode(201)
  async create(@Headers() headers: H, @Body() body: unknown): Promise<Success<WithSecret>> {
    const r = await this.registry.call<"createServiceAccount", WithSecret>(
      "createServiceAccount",
      objectBody(body) as RegistrySchemas["CreateServiceAccountInput"],
      forwardFrom(headers, { idempotency: true }),
    );
    return success(r.data);
  }

  @Operation("rotateServiceAccountSecret")
  @Post(":id/rotate-secret")
  @HttpCode(200)
  async rotate(@Headers() headers: H, @Param("id") id: string): Promise<Success<WithSecret>> {
    const r = await this.registry.call<"rotateServiceAccountSecret", WithSecret>(
      "rotateServiceAccountSecret",
      { serviceAccountId: uuidParam(id, "id") },
      forwardFrom(headers, { idempotency: true }),
    );
    return success(r.data);
  }

  @Operation("revokeServiceAccount")
  @Delete(":id")
  async revoke(@Headers() headers: H, @Param("id") id: string): Promise<Success<Account>> {
    const r = await this.registry.call<"revokeServiceAccount", Account>(
      "revokeServiceAccount",
      { serviceAccountId: uuidParam(id, "id") },
      forwardFrom(headers, { idempotency: true }),
    );
    return success(r.data);
  }
}
