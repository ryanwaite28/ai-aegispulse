"""JWT verification (FR-AUTH-01/04/05, FR-TEN-07, PROJECT.md §8 "JWT validation note", ADR-0010).

RS256 only; kid from the registry JWKS (cached 10 min, refetched on unknown kid); iss, exp/nbf with 60 s leeway; jti
required. ``typ`` is exactly one of:
  user        aud = JWT_AUDIENCE         sub, tid, tslug, roles[]
  integration aud = JWT_AUDIENCE         sub (clientId), tid, tslug, roles = ["INTEGRATION"]
  service     aud = aegispulse-internal  sub (svc-<runtime>), act[]
Anything else (unknown/missing typ, typ on the other audience) is rejected with UNAUTHORIZED.
"""

import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import jwt
from jwt import PyJWKClient

from aegis_platform.errors import ForbiddenError, UnauthorizedError

INTERNAL_AUDIENCE = "aegispulse-internal"


@dataclass(frozen=True, slots=True)
class UserPrincipal:
    user_id: str
    tenant_id: str
    tenant_slug: str
    roles: tuple[str, ...]
    token_id: str


@dataclass(frozen=True, slots=True)
class IntegrationPrincipal:
    client_id: str
    tenant_id: str
    tenant_slug: str
    roles: tuple[str, ...]
    token_id: str


@dataclass(frozen=True, slots=True)
class ServicePrincipal:
    client_id: str
    actions: tuple[str, ...]


TenantPrincipal = UserPrincipal | IntegrationPrincipal
Principal = TenantPrincipal | ServicePrincipal

KeyResolver = Callable[[str], Any]
"""Returns the verification key for a token (default: PyJWKClient over the registry JWKS)."""


def bearer_token(authorization: str | None) -> str:
    if authorization is None or not authorization.startswith("Bearer ") or " " in authorization[7:].strip():
        raise UnauthorizedError("UNAUTHORIZED", "missing or malformed bearer token")
    return authorization[7:].strip()


def _str_claim(claims: dict[str, Any], name: str) -> str:
    value = claims.get(name)
    if not isinstance(value, str) or value == "":
        raise UnauthorizedError("UNAUTHORIZED", f"token claim {name} missing")
    return value


def _list_claim(claims: dict[str, Any], name: str) -> tuple[str, ...]:
    value = claims.get(name)
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise UnauthorizedError("UNAUTHORIZED", f"token claim {name} missing")
    return tuple(value)


class JwtVerifier:
    """Verifies tokens locally; no service trusts the gateway's validation alone (FR-AUTH-05)."""

    def __init__(
        self,
        *,
        issuer: str,
        audience: str,
        jwks_url: str | None = None,
        key_resolver: KeyResolver | None = None,
        internal_audience: str = INTERNAL_AUDIENCE,
        leeway_seconds: int = 60,
    ) -> None:
        if key_resolver is None:
            if jwks_url is None:
                raise ValueError("jwks_url or key_resolver is required")
            client = PyJWKClient(jwks_url, cache_jwk_set=True, lifespan=600, timeout=1)
            key_resolver = lambda token: client.get_signing_key_from_jwt(token).key  # noqa: E731
        self._keys = key_resolver
        self._issuer = issuer
        self._audience = audience
        self._internal_audience = internal_audience
        self._leeway = leeway_seconds

    def _decode(self, token: str, audience: str) -> dict[str, Any]:
        try:
            claims: dict[str, Any] = jwt.decode(
                token,
                key=self._keys(token),
                algorithms=["RS256"],
                audience=audience,
                issuer=self._issuer,
                leeway=self._leeway,
                options={"require": ["exp", "iat", "sub", "jti", "iss", "aud"]},
            )
        except (jwt.PyJWTError, ValueError) as e:
            raise UnauthorizedError("UNAUTHORIZED", f"token rejected ({type(e).__name__})") from None
        return claims

    def verify_tenant(self, token: str) -> TenantPrincipal:
        """Public-audience token: typ=user or typ=integration."""
        claims = self._decode(token, self._audience)
        typ = claims.get("typ")
        roles = _list_claim(claims, "roles")
        tenant = (_str_claim(claims, "tid"), _str_claim(claims, "tslug"), roles, _str_claim(claims, "jti"))
        if typ == "user":
            return UserPrincipal(_str_claim(claims, "sub"), *tenant)
        if typ == "integration":
            if roles != ("INTEGRATION",):
                raise UnauthorizedError("UNAUTHORIZED", "integration token roles")
            return IntegrationPrincipal(_str_claim(claims, "sub"), *tenant)
        raise UnauthorizedError("UNAUTHORIZED", "token typ not accepted on this audience")

    def verify_service(self, token: str) -> ServicePrincipal:
        """Internal-audience token: typ=service with act[] (FR-TEN-07)."""
        claims = self._decode(token, self._internal_audience)
        if claims.get("typ") != "service":
            raise UnauthorizedError("UNAUTHORIZED", "not a service token")
        return ServicePrincipal(_str_claim(claims, "sub"), _list_claim(claims, "act"))

    def authorize_internal(self, authorization: str | None, action: str) -> Principal:
        """§6.2: a forwarded user/integration token, or a SERVICE token whose act[] includes ``action``."""
        token = bearer_token(authorization)
        try:
            return self.verify_tenant(token)
        except UnauthorizedError as tenant_error:
            try:
                service = self.verify_service(token)
            except UnauthorizedError:
                raise tenant_error from None
        if action not in service.actions:
            raise ForbiddenError("FORBIDDEN", f"service {service.client_id} may not call {action}")
        return service


def has_role(principal: Principal, *roles: str) -> bool:
    return not isinstance(principal, ServicePrincipal) and any(r in principal.roles for r in roles)


@dataclass(frozen=True, slots=True)
class AccessToken:
    access_token: str
    expires_in: int


class ServiceTokenProvider:
    """Caches the runtime's SERVICE token and renews it ``refresh_skew`` seconds before expiry (FR-TEN-07)."""

    def __init__(
        self,
        issue: Callable[[], Awaitable[AccessToken]],
        *,
        refresh_skew: float = 60,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._issue = issue
        self._skew = refresh_skew
        self._clock = clock
        self._token: str | None = None
        self._expires_at = 0.0

    async def token(self) -> str:
        if self._token is not None and self._clock() < self._expires_at - self._skew:
            return self._token
        issued = await self._issue()
        self._token = issued.access_token
        self._expires_at = self._clock() + issued.expires_in
        return issued.access_token
