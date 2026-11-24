"""FR-AUTH-01/04/05, FR-TEN-07: token typ rules, audiences, leeway, act[]."""

import time
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from aegis_platform.auth import (
    IntegrationPrincipal,
    JwtVerifier,
    ServicePrincipal,
    UserPrincipal,
    bearer_token,
    has_role,
)
from aegis_platform.errors import ForbiddenError, UnauthorizedError

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
FOREIGN = rsa.generate_private_key(public_exponent=65537, key_size=2048)
ISS = "aegispulse-registry"
VERIFIER = JwtVerifier(issuer=ISS, audience="aegispulse", key_resolver=lambda _: KEY.public_key())


def sign(claims: dict[str, Any], aud: str = "aegispulse", exp_in: int = 900, key: Any = KEY, alg: str = "RS256") -> str:
    now = int(time.time())
    body = {"iss": ISS, "aud": aud, "sub": "u-1", "jti": "j-1", "iat": now + exp_in - 900, "exp": now + exp_in}
    body.update(claims)
    return jwt.encode(body, key if alg == "RS256" else "x" * 32, algorithm=alg, headers={"kid": "k1"})


USER = {"typ": "user", "tid": "t-1", "tslug": "acme", "roles": ["ANALYST"]}


def test_user_and_integration_tokens_are_tenant_principals() -> None:
    assert VERIFIER.verify_tenant(sign(USER)) == UserPrincipal("u-1", "t-1", "acme", ("ANALYST",), "j-1")
    integ = VERIFIER.verify_tenant(sign({**USER, "typ": "integration", "sub": "cli_1", "roles": ["INTEGRATION"]}))
    assert integ == IntegrationPrincipal("cli_1", "t-1", "acme", ("INTEGRATION",), "j-1")
    assert has_role(integ, "INTEGRATION")
    with pytest.raises(UnauthorizedError):
        VERIFIER.verify_tenant(sign({**USER, "typ": "integration", "roles": ["TENANT_ADMIN"]}))


@pytest.mark.parametrize(
    ("claims", "aud", "exp_in", "key", "alg"),
    [
        (USER, "aegispulse-dev", 900, KEY, "RS256"),  # dev token in prod
        (USER, "aegispulse", 900, FOREIGN, "RS256"),  # foreign key
        (USER, "aegispulse", 900, KEY, "HS256"),  # alg confusion
        (USER, "aegispulse", -120, KEY, "RS256"),  # expired beyond leeway
        ({k: v for k, v in USER.items() if k != "typ"}, "aegispulse", 900, KEY, "RS256"),  # missing typ
        ({**USER, "typ": "admin"}, "aegispulse", 900, KEY, "RS256"),  # unknown typ
        ({"typ": "service", "act": ["x"]}, "aegispulse", 900, KEY, "RS256"),  # service token on the public audience
    ],
)
def test_rejects_wrong_tokens(claims: dict[str, Any], aud: str, exp_in: int, key: Any, alg: str) -> None:
    with pytest.raises(UnauthorizedError):
        VERIFIER.verify_tenant(sign(claims, aud, exp_in, key, alg))


def test_leeway_accepts_recently_expired() -> None:
    assert isinstance(VERIFIER.verify_tenant(sign(USER, exp_in=-30)), UserPrincipal)


def test_internal_calls_need_user_or_service_with_act() -> None:
    svc = sign({"typ": "service", "sub": "svc-orchestrator", "act": ["dataIntel.getDrift"]}, aud="aegispulse-internal")
    assert VERIFIER.authorize_internal(f"Bearer {svc}", "dataIntel.getDrift") == ServicePrincipal(
        "svc-orchestrator", ("dataIntel.getDrift",)
    )
    with pytest.raises(ForbiddenError):
        VERIFIER.authorize_internal(f"Bearer {svc}", "dataIntel.runRollups")
    no_typ = sign({"sub": "svc-x", "act": ["dataIntel.getDrift"]}, aud="aegispulse-internal")
    with pytest.raises(UnauthorizedError):
        VERIFIER.authorize_internal(f"Bearer {no_typ}", "dataIntel.getDrift")
    user_internal = sign(USER, aud="aegispulse-internal")
    with pytest.raises(UnauthorizedError):
        VERIFIER.authorize_internal(f"Bearer {user_internal}", "dataIntel.getDrift")
    assert isinstance(VERIFIER.authorize_internal(f"Bearer {sign(USER)}", "dataIntel.getDrift"), UserPrincipal)
    for bad in (None, "Basic abc", "Bearer a b"):
        with pytest.raises(UnauthorizedError):
            bearer_token(bad)
