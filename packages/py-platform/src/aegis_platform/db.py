"""PostgreSQL helpers on psycopg 3 (async): transactions, tenant scope (§7.0, NFR-06), readiness checks (NFR-11).

There is no RLS bypass: cross-tenant work calls migration-defined SECURITY DEFINER functions owned by
``{schema}_platform`` (ADR-0016)."""

import re
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool

from aegis_platform.checks import Check

_IDENT = re.compile(r"^[a-z][a-z_]*$")


def qualified(schema: str, name: str) -> str:
    """Validated, quoted ``"schema".name`` (schemas are fixed per service, never user input)."""
    if not _IDENT.fullmatch(schema) or not _IDENT.fullmatch(name):
        raise ValueError("invalid identifier")
    return f'"{schema}".{name}'


@asynccontextmanager
async def transaction(pool: AsyncConnectionPool[AsyncConnection]) -> AsyncIterator[AsyncConnection]:
    """A transaction without tenant context (tenant tables fail closed under RLS)."""
    async with pool.connection() as conn, conn.transaction():
        yield conn


@asynccontextmanager
async def tenant_transaction(
    pool: AsyncConnectionPool[AsyncConnection], tenant_id: uuid.UUID
) -> AsyncIterator[AsyncConnection]:
    """A transaction scoped to one tenant: ``SET LOCAL app.tenant_id`` first, so RLS admits only its rows."""
    async with pool.connection() as conn, conn.transaction():
        await conn.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tenant_id),))
        yield conn


def postgres_ping_check(pool: AsyncConnectionPool[AsyncConnection]) -> Check:
    async def check() -> None:
        async with pool.connection() as conn:
            await conn.execute("SELECT 1")

    return check


def _version_key(v: str) -> tuple[int, ...]:
    return tuple(int(p) for p in v.split("."))


def flyway_version_check(pool: AsyncConnectionPool[AsyncConnection], schema: str, min_version: str) -> Check:
    """NFR-11 (c): newest successful Flyway migration of ``schema`` must be >= ``min_version``."""
    table = qualified(schema, "flyway_schema_history")

    async def check() -> None:
        async with pool.connection() as conn:
            cur = await conn.execute(f"SELECT version FROM {table} WHERE success AND version IS NOT NULL")  # noqa: S608
            versions = [row[0] for row in await cur.fetchall()]
        if not versions:
            raise RuntimeError(f"no applied migrations in {schema}")
        newest = max(versions, key=_version_key)
        if _version_key(newest) < _version_key(min_version):
            raise RuntimeError(f"schema {schema} at V{newest}, need >= V{min_version}")

    return check
