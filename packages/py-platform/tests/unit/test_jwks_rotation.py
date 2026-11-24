"""FR-AUTH-05: the remote JWKS is cached (10 min) and refetched on an unknown kid after the kit's 5 s cooldown."""

import json
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, ClassVar

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

from aegis_platform.auth import JwtVerifier

ISS = "aegispulse-registry"
K1 = rsa.generate_private_key(public_exponent=65537, key_size=2048)
K2 = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _jwk(key: rsa.RSAPrivateKey, kid: str) -> dict[str, Any]:
    jwk: dict[str, Any] = json.loads(RSAAlgorithm.to_jwk(key.public_key()))
    return {**jwk, "kid": kid, "alg": "RS256", "use": "sig"}


def _token(key: rsa.RSAPrivateKey, kid: str) -> str:
    now = int(time.time())
    claims = {
        "typ": "user",
        "tid": "t-1",
        "tslug": "acme",
        "roles": ["ANALYST"],
        "jti": f"j-{kid}",
        "sub": "u-1",
        "iss": ISS,
        "aud": "aegispulse",
        "iat": now,
        "exp": now + 900,
    }
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": kid})


class _State:
    served: ClassVar[dict[str, Any]] = {"keys": []}
    fetches: ClassVar[int] = 0


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        _State.fetches += 1
        body = json.dumps(_State.served).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        return


@pytest.fixture
def jwks_url() -> Iterator[str]:
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}/.well-known/jwks.json"
    server.shutdown()


def test_fr_auth_05_unknown_kid_refetches_and_previous_key_still_verifies(
    jwks_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    _State.served = {"keys": [_jwk(K1, "k1")]}
    _State.fetches = 0
    verifier = JwtVerifier(issuer=ISS, audience="aegispulse", jwks_url=jwks_url)
    verifier.verify_tenant(_token(K1, "k1"))
    verifier.verify_tenant(_token(K1, "k1"))
    assert _State.fetches == 1  # cached

    _State.served = {"keys": [_jwk(K2, "k2"), _jwk(K1, "k1")]}  # rotation
    real = time.monotonic
    monkeypatch.setattr(time, "monotonic", lambda: real() + 6)  # past the 5 s cooldown, inside the 10 min cache
    assert verifier.verify_tenant(_token(K2, "k2"))
    assert _State.fetches == 2  # refetched on the unknown kid, inside the 10 min window
    assert verifier.verify_tenant(_token(K1, "k1"))
