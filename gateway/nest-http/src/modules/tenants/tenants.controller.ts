// /v1/tenants* (FR-TEN-01/02/03/08). PATCH carries either settings (TENANT_ADMIN) or a status change (PLATFORM_ADMIN)
// per the contract's oneOf; the body shape selects the backing action, and registry authorizes each.
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post } from "@nestjs/common";
import { REGISTRY } from "../../config.js";
import type { RegistryClient, RegistrySchemas } from "../../clients/registry.client.js";
import { Operation } from "../../common/guards/jwt-auth.guard.js";
import { success, type Success } from "../../common/mappers/envelope.js";
import { forwardFrom, objectBody, uuidParam } from "../../common/mappers/forward.js";

type H = Record<string, string | string[] | undefined>;
type Tenant = RegistrySchemas["Tenant"];

@Controller("v1/tenants")
export class TenantsController {
  constructor(@Inject(REGISTRY) private readonly registry: RegistryClient) {}

  @Operation("createTenant")
  @Post()
  @HttpCode(201)
  async create(@Headers() headers: H, @Body() body: unknown): Promise<Success<Tenant>> {
    const r = await this.registry.call<"createTenant", Tenant>(
      "createTenant",
      objectBody(body) as RegistrySchemas["CreateTenantInput"],
      forwardFrom(headers, { idempotency: true }),
    );
    return success(r.data);
  }

  @Operation("getTenant")
  @Get(":tenantId")
  async get(@Headers() headers: H, @Param("tenantId") tenantId: string): Promise<Success<Tenant>> {
    const r = await this.registry.call<"getTenantSettings", Tenant>(
      "getTenantSettings",
      { tenantId: uuidParam(tenantId, "tenantId") },
      forwardFrom(headers, { tenant: true }),
    );
    return success(r.data);
  }

  @Operation("updateTenant")
  @Patch(":tenantId")
  async update(
    @Headers() headers: H,
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
  ): Promise<Success<Tenant>> {
    const input = objectBody(body);
    const id = uuidParam(tenantId, "tenantId");
    const forward = forwardFrom(headers, { tenant: true, idempotency: true });
    const r =
      "status" in input
        ? await this.registry.call<"updateTenantStatus", Tenant>(
            "updateTenantStatus",
            { ...(input as Omit<RegistrySchemas["UpdateTenantStatusInput"], "tenantId">), tenantId: id },
            forward,
          )
        : await this.registry.call<"updateTenantSettings", Tenant>(
            "updateTenantSettings",
            { ...(input as Omit<RegistrySchemas["UpdateTenantSettingsInput"], "tenantId">), tenantId: id },
            forward,
          );
    return success(r.data);
  }
}
