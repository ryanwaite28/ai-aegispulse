"""Caller-side tenant settings cache (FR-TEN-08: "cached ≤ 60 s by callers").

Transport-independent: the caller supplies an async ``fetch(tenant_id)`` (the registry's ``getTenantSettings``
action with the runtime's SERVICE token). Entries live at most 60 s; concurrent misses share one fetch; failures are
never cached; ``invalidate`` serves consumers of ``registry.tenant.settings_changed``.
"""

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any

MAX_TTL_SECONDS = 60.0

TenantSettings = dict[str, Any]
Fetch = Callable[[str], Awaitable[TenantSettings]]


class TenantSettingsCache:
    def __init__(self, fetch: Fetch, ttl_seconds: float = MAX_TTL_SECONDS, clock: Callable[[], float] = time.monotonic):
        self._fetch = fetch
        self._ttl = min(ttl_seconds, MAX_TTL_SECONDS)
        self._clock = clock
        self._entries: dict[str, tuple[TenantSettings, float]] = {}
        self._inflight: dict[str, asyncio.Future[TenantSettings]] = {}

    async def get(self, tenant_id: str) -> TenantSettings:
        hit = self._entries.get(tenant_id)
        if hit is not None and self._clock() < hit[1]:
            return hit[0]
        pending = self._inflight.get(tenant_id)
        if pending is not None:
            return await asyncio.shield(pending)
        future: asyncio.Future[TenantSettings] = asyncio.get_running_loop().create_future()
        self._inflight[tenant_id] = future
        try:
            value = await self._fetch(tenant_id)
        except BaseException as e:
            future.set_exception(e)
            future.exception()  # mark retrieved for waiters that never come
            raise
        else:
            self._entries[tenant_id] = (value, self._clock() + self._ttl)
            future.set_result(value)
            return value
        finally:
            self._inflight.pop(tenant_id, None)

    def invalidate(self, tenant_id: str) -> None:
        self._entries.pop(tenant_id, None)
