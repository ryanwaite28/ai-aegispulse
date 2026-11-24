// /v1/users* (FR-TEN-04/05): TENANT_ADMIN, or PLATFORM_ADMIN via X-Aegis-Tenant (§6.2).
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { REGISTRY } from "../../config.js";
import type { RegistryClient, RegistrySchemas } from "../../clients/registry.client.js";
import { Operation } from "../../common/guards/jwt-auth.guard.js";
import { success, type Success } from "../../common/mappers/envelope.js";
import { forwardFrom, objectBody, pageQuery, uuidParam } from "../../common/mappers/forward.js";

type H = Record<string, string | string[] | undefined>;
type User = RegistrySchemas["User"];

@Controller("v1/users")
export class UsersController {
  constructor(@Inject(REGISTRY) private readonly registry: RegistryClient) {}

  @Operation("listUsers")
  @Get()
  async list(@Headers() headers: H, @Query() query: Record<string, unknown>): Promise<Success<User[]>> {
    const r = await this.registry.call<"listUsers", User[]>(
      "listUsers",
      pageQuery(query) as RegistrySchemas["ListUsersQuery"],
      forwardFrom(headers, { tenant: true }),
    );
    return success(r.data, r.meta.nextCursor);
  }

  @Operation("createUser")
  @Post()
  @HttpCode(201)
  async create(@Headers() headers: H, @Body() body: unknown): Promise<Success<User>> {
    const r = await this.registry.call<"createUser", User>(
      "createUser",
      objectBody(body) as RegistrySchemas["CreateUserInput"],
      forwardFrom(headers, { tenant: true, idempotency: true }),
    );
    return success(r.data);
  }

  @Operation("updateUser")
  @Patch(":userId")
  async update(@Headers() headers: H, @Param("userId") userId: string, @Body() body: unknown): Promise<Success<User>> {
    const r = await this.registry.call<"updateUser", User>(
      "updateUser",
      {
        ...(objectBody(body) as Omit<RegistrySchemas["UpdateUserInput"], "userId">),
        userId: uuidParam(userId, "userId"),
      },
      forwardFrom(headers, { tenant: true, idempotency: true }),
    );
    return success(r.data);
  }
}
