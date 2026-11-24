// JWT verification (FR-AUTH-01/04/05, FR-TEN-07, PROJECT.md §8 "JWT validation note", §5.7.4):
// RS256 only, kid from a cached remote JWKS (refresh every 10 min or on unknown kid), iss/aud/exp/nbf with
// 60 s leeway. `typ` is exactly one of:
//   user        aud = JWT_AUDIENCE,          sub, tid, tslug, roles[], jti
//   integration aud = JWT_AUDIENCE,          sub (clientId), tid, tslug, roles = ["INTEGRATION"], jti
//   service     aud = aegispulse-internal,   sub (svc-<runtime>), act[], jti; no tid/roles
// Any other or missing typ, or a typ presented on the wrong audience, is rejected. Every service re-verifies.
import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { DomainError } from "../errors/index.js";

export const INTERNAL_AUDIENCE = "aegispulse-internal";

export interface UserPrincipal {
  readonly kind: "user";
  readonly userId: string;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly roles: readonly string[];
  readonly tokenId: string;
}

/** INTEGRATION service account (FR-TEN-06, FR-AUTH-04): tenant-scoped like a user, role INTEGRATION only. */
export interface IntegrationPrincipal {
  readonly kind: "integration";
  readonly clientId: string;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly roles: readonly string[];
  readonly tokenId: string;
}

export interface ServicePrincipal {
  readonly kind: "service";
  readonly clientId: string;
  readonly actions: readonly string[];
}

/** Tenant-scoped callers (public audience). */
export type TenantPrincipal = UserPrincipal | IntegrationPrincipal;
export type Principal = TenantPrincipal | ServicePrincipal;

export interface JwtVerifierOptions {
  /** e.g. `${REGISTRY_URL}/.well-known/jwks.json`, or a key resolver (tests). */
  readonly jwks: URL | JWTVerifyGetKey;
  readonly issuer: string;
  /** JWT_AUDIENCE: aegispulse in prod, aegispulse-dev in dev. */
  readonly audience: string;
  readonly internalAudience?: string;
  readonly clockToleranceSec?: number;
}

const unauthorized = (message: string, cause?: unknown): DomainError =>
  new DomainError("UNAUTHORIZED", message, cause === undefined ? {} : { cause });

function stringClaim(payload: JWTPayload, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || value.length === 0) throw unauthorized(`token claim ${name} missing`);
  return value;
}

function stringArrayClaim(payload: JWTPayload, name: string): string[] {
  const value = payload[name];
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string")) {
    throw unauthorized(`token claim ${name} missing`);
  }
  return value;
}

/** Extracts the token from an `Authorization: Bearer …` header. */
export function bearerToken(authorization: string | undefined): string {
  if (authorization === undefined) throw unauthorized("missing bearer token");
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(authorization.trim());
  if (match?.[1] === undefined) throw unauthorized("malformed authorization header");
  return match[1];
}

export class JwtVerifier {
  private readonly keys: JWTVerifyGetKey;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly internalAudience: string;
  private readonly clockTolerance: number;

  constructor(options: JwtVerifierOptions) {
    this.keys =
      options.jwks instanceof URL
        ? createRemoteJWKSet(options.jwks, {
            cacheMaxAge: 10 * 60_000,
            cooldownDuration: 5_000, // FR-AUTH-05: a rotated-in kid is picked up within 5 s (rotation drill 2026-11-23)
            timeoutDuration: 1_000,
          })
        : options.jwks;
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.internalAudience = options.internalAudience ?? INTERNAL_AUDIENCE;
    this.clockTolerance = options.clockToleranceSec ?? 60;
  }

  private async verify(token: string, audience: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        algorithms: ["RS256"],
        issuer: this.issuer,
        audience,
        clockTolerance: this.clockTolerance,
        requiredClaims: ["sub", "exp", "iat"],
      });
      return payload;
    } catch (error: unknown) {
      if (error instanceof joseErrors.JOSEError) throw unauthorized(`token rejected (${error.code})`, error);
      throw error;
    }
  }

  /** Verifies a public-audience token: typ=user or typ=integration (FR-AUTH-01, FR-AUTH-04). */
  async verifyTenant(token: string): Promise<TenantPrincipal> {
    const payload = await this.verify(token, this.audience);
    const typ = payload["typ"];
    const tenant = {
      tenantId: stringClaim(payload, "tid"),
      tenantSlug: stringClaim(payload, "tslug"),
      roles: stringArrayClaim(payload, "roles"),
      tokenId: stringClaim(payload, "jti"),
    };
    if (typ === "user") return { kind: "user", userId: stringClaim(payload, "sub"), ...tenant };
    if (typ === "integration") {
      if (tenant.roles.length !== 1 || tenant.roles[0] !== "INTEGRATION") throw unauthorized("integration token roles");
      return { kind: "integration", clientId: stringClaim(payload, "sub"), ...tenant };
    }
    throw unauthorized("token typ not accepted on this audience");
  }

  /** Verifies a typ=user token only (endpoints such as password change that integrations may not call). */
  async verifyUser(token: string): Promise<UserPrincipal> {
    const principal = await this.verifyTenant(token);
    if (principal.kind !== "user") throw unauthorized("not a user token");
    return principal;
  }

  /** Verifies an internal-audience token: typ=service with act[] (FR-TEN-07). */
  async verifyService(token: string): Promise<ServicePrincipal> {
    const payload = await this.verify(token, this.internalAudience);
    if (payload["typ"] !== "service") throw unauthorized("not a service token");
    stringClaim(payload, "jti");
    return { kind: "service", clientId: stringClaim(payload, "sub"), actions: stringArrayClaim(payload, "act") };
  }

  /**
   * Authenticates an internal call (§6.2): a forwarded user/integration token, or a SERVICE token whose act[]
   * includes `action` (e.g. "registry.resolveEntities"). Role and tenant checks stay in the service layer.
   */
  async authorizeInternal(authorization: string | undefined, action: string): Promise<Principal> {
    const token = bearerToken(authorization);
    let userError: unknown;
    try {
      return await this.verifyTenant(token);
    } catch (error: unknown) {
      userError = error;
    }
    let service: ServicePrincipal;
    try {
      service = await this.verifyService(token);
    } catch {
      throw userError;
    }
    if (!service.actions.includes(action)) {
      throw new DomainError("FORBIDDEN", `service ${service.clientId} is not allowed to call ${action}`);
    }
    return service;
  }
}

export function hasRole(principal: Principal, ...roles: readonly string[]): boolean {
  return principal.kind !== "service" && roles.some((r) => principal.roles.includes(r));
}

// ── SERVICE token acquisition (FR-TEN-07) ─────────────────────────────────────

export interface AccessToken {
  readonly accessToken: string;
  readonly expiresIn: number;
}

export interface ServiceTokenProviderOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Calls registry `issueClientCredentialsToken` (unauthenticated internal action). */
  readonly issue: (input: {
    clientId: string;
    clientSecret: string;
    audience: "aegispulse-internal";
  }) => Promise<AccessToken>;
  /** Renew this long before expiry. Default 60 s. */
  readonly refreshSkewSec?: number;
  readonly now?: () => number;
}

/** Caches the runtime's SERVICE token and renews it before expiry; concurrent callers share one request. */
export class ServiceTokenProvider {
  private cached: { token: string; expiresAt: number } | undefined;
  private inflight: Promise<string> | undefined;
  private readonly now: () => number;

  constructor(private readonly options: ServiceTokenProviderOptions) {
    this.now = options.now ?? Date.now;
  }

  token = async (): Promise<string> => {
    const skewMs = (this.options.refreshSkewSec ?? 60) * 1000;
    if (this.cached !== undefined && this.now() < this.cached.expiresAt - skewMs) return this.cached.token;
    this.inflight ??= this.fetch().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  };

  private async fetch(): Promise<string> {
    const issued = await this.options.issue({
      clientId: this.options.clientId,
      clientSecret: this.options.clientSecret,
      audience: INTERNAL_AUDIENCE,
    });
    this.cached = { token: issued.accessToken, expiresAt: this.now() + issued.expiresIn * 1000 };
    return issued.accessToken;
  }
}

// ── Tenant-scoped authorization (FR-AUTH-06, §6.2) ─────────────────────────────

/** FR-TEN-09 reserved tenant: never an acting tenant. */
export const PLATFORM_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export interface TenantAccess {
  /** The tenant the action runs in (own tenant, or the X-Aegis-Tenant target for PLATFORM_ADMIN). */
  readonly tenantId: string;
  /** Stable actor reference for audit/history: `user:{uuid}` or `integration:{clientId}`. */
  readonly actor: string;
  /** The user id for user principals; null for INTEGRATION accounts. */
  readonly userId: string | null;
  readonly roles: readonly string[];
  readonly actingAsPlatformAdmin: boolean;
}

/**
 * Same rule as the registry's TenantAccess (§6.2): the caller's roles must intersect `allowedRoles` (the contract's
 * x-aegis-roles); PLATFORM_ADMIN must name the tenant with X-Aegis-Tenant (never the platform tenant → 404); any
 * other principal sending the header → 403. SERVICE principals are refused (they use their own act[] actions).
 */
export function tenantAccess(
  principal: Principal,
  actingTenant: string | undefined,
  allowedRoles: readonly string[],
): TenantAccess {
  if (principal.kind === "service") throw new DomainError("FORBIDDEN", "this action requires a tenant principal");
  if (!principal.roles.some((r) => allowedRoles.includes(r))) {
    throw new DomainError("FORBIDDEN", "role not allowed for this action");
  }
  const actor = principal.kind === "user" ? `user:${principal.userId}` : `integration:${principal.clientId}`;
  const userId = principal.kind === "user" ? principal.userId : null;
  if (principal.roles.includes("PLATFORM_ADMIN")) {
    if (actingTenant === undefined) {
      throw new DomainError("FORBIDDEN", "PLATFORM_ADMIN must name the tenant with X-Aegis-Tenant");
    }
    if (actingTenant === PLATFORM_TENANT_ID) throw new DomainError("NOT_FOUND", "tenant not found");
    return { tenantId: actingTenant, actor, userId, roles: principal.roles, actingAsPlatformAdmin: true };
  }
  if (actingTenant !== undefined) throw new DomainError("FORBIDDEN", "X-Aegis-Tenant is for PLATFORM_ADMIN only");
  return { tenantId: principal.tenantId, actor, userId, roles: principal.roles, actingAsPlatformAdmin: false };
}
