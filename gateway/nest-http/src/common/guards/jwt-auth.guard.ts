// JWKS auth guard (§8.3 "JWT validation note", FR-AUTH-05/06, ADR-0010): every route is authenticated unless marked
// @Public(). Verifies RS256 via the registry JWKS and the `typ` rules (user/integration on JWT_AUDIENCE), then checks
// the caller's roles against the route's x-aegis-roles from the generated contract table (@Operation). This is the
// coarse edge check; owning services re-verify the token and enforce role + tenant ownership themselves.
import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GatewayOperationId, GatewayRoute } from "@aegispulse/contracts/generated/ts/gateway-routes.ts";
import type { JwtVerifier, TenantPrincipal } from "@aegispulse/ts-platform/auth";
import { bearerToken } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import { JWT_VERIFIER } from "../../config.js";

export const IS_PUBLIC = "aegis:public";
export const OPERATION = "aegis:operation";
/** Marks a handler or controller as unauthenticated (only routes §8.3 lists without 🔒). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
/** Binds a handler to its gateway.public.yaml operationId; the guard enforces that route's x-aegis-roles. */
export const Operation = (id: GatewayOperationId): MethodDecorator => SetMetadata(OPERATION, id);

/** Generated from gateway.public.yaml (packages/contracts `make contracts`); loaded once at startup. */
const GATEWAY_ROUTES = JSON.parse(
  readFileSync(fileURLToPath(import.meta.resolve("@aegispulse/contracts/gateway-routes")), "utf8"),
) as Readonly<Record<GatewayOperationId, GatewayRoute>>;

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  principal?: TenantPrincipal;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(JWT_VERIFIER) private readonly verifier: JwtVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers["authorization"];
    const principal = await this.verifier.verifyTenant(bearerToken(typeof header === "string" ? header : undefined));
    request.principal = principal;
    const operation = this.reflector.get<GatewayOperationId | undefined>(OPERATION, context.getHandler());
    if (operation !== undefined) {
      const roles: readonly string[] = GATEWAY_ROUTES[operation].roles;
      if (roles.length > 0 && !principal.roles.some((r) => roles.includes(r))) {
        throw new DomainError("FORBIDDEN", "role not allowed for this route");
      }
    }
    return true;
  }
}
