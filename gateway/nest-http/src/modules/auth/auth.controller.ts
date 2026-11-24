// /v1/auth/* (FR-AUTH-01..04, 07): parse → one registry action → map. No credentials are logged or inspected here.
import { Body, Controller, Get, Headers, HttpCode, Inject, Post } from "@nestjs/common";
import { REGISTRY } from "../../config.js";
import type { RegistryClient, RegistrySchemas } from "../../clients/registry.client.js";
import { Operation, Public } from "../../common/guards/jwt-auth.guard.js";
import { success, type Success } from "../../common/mappers/envelope.js";
import { forwardFrom, objectBody } from "../../common/mappers/forward.js";

type H = Record<string, string | string[] | undefined>;

@Controller("v1/auth")
export class AuthController {
  constructor(@Inject(REGISTRY) private readonly registry: RegistryClient) {}

  @Public()
  @Post("login")
  @HttpCode(200)
  async login(@Body() body: unknown): Promise<Success<RegistrySchemas["TokenPair"]>> {
    const r = await this.registry.callAsGateway<"login", RegistrySchemas["TokenPair"]>(
      "login",
      objectBody(body) as RegistrySchemas["LoginInput"],
    );
    return success(r.data);
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  async refresh(@Body() body: unknown): Promise<Success<RegistrySchemas["TokenPair"]>> {
    const r = await this.registry.callAsGateway<"refreshToken", RegistrySchemas["TokenPair"]>(
      "refreshToken",
      objectBody(body) as RegistrySchemas["RefreshTokenInput"],
    );
    return success(r.data);
  }

  @Operation("logout")
  @Post("logout")
  @HttpCode(200)
  async logout(@Headers() headers: H, @Body() body: unknown): Promise<Success<unknown>> {
    const r = await this.registry.call(
      "logout",
      objectBody(body) as RegistrySchemas["LogoutInput"],
      forwardFrom(headers, { tenant: true }),
    );
    return success(r.data);
  }

  @Operation("changePassword")
  @Post("password")
  @HttpCode(200)
  async changePassword(@Headers() headers: H, @Body() body: unknown): Promise<Success<unknown>> {
    const r = await this.registry.call(
      "changePassword",
      objectBody(body) as RegistrySchemas["ChangePasswordInput"],
      forwardFrom(headers, { tenant: true }),
    );
    return success(r.data);
  }

  @Operation("getCurrentPrincipal")
  @Get("me")
  async me(@Headers() headers: H): Promise<Success<RegistrySchemas["Principal"]>> {
    const r = await this.registry.call<"getCurrentPrincipal", RegistrySchemas["Principal"]>(
      "getCurrentPrincipal",
      {},
      forwardFrom(headers, { tenant: true }),
    );
    return success(r.data);
  }

  /** INTEGRATION client credentials: no bearer; the audience is fixed to the public one on this route. */
  @Public()
  @Post("token")
  @HttpCode(200)
  async token(@Body() body: unknown): Promise<Success<RegistrySchemas["AccessToken"]>> {
    const input = objectBody(body);
    const r = await this.registry.call<"issueClientCredentialsToken", RegistrySchemas["AccessToken"]>(
      "issueClientCredentialsToken",
      { ...(input as RegistrySchemas["IssueClientCredentialsTokenInput"]), audience: "aegispulse" },
      {},
    );
    return success(r.data);
  }
}
