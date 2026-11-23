// JWKS auth guard (§8.3 "JWT validation note", FR-AUTH-05, ADR-0010): every route is authenticated unless marked
// @Public(). Verifies RS256 via the registry JWKS and the `typ` rules (user/integration on JWT_AUDIENCE), attaches the
// principal for mappers/clients, and forwards nothing it did not verify. Owning services re-verify.
import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { JwtVerifier, TenantPrincipal } from "@aegispulse/ts-platform/auth";
import { bearerToken } from "@aegispulse/ts-platform/auth";
import { JWT_VERIFIER } from "../../config.js";

export const IS_PUBLIC = "aegis:public";
/** Marks a handler or controller as unauthenticated (only routes §8.3 lists without 🔒). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

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
    request.principal = await this.verifier.verifyTenant(bearerToken(typeof header === "string" ? header : undefined));
    return true;
  }
}
