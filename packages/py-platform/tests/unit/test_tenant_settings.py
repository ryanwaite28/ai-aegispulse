"""FR-TEN-08: callers cache tenant settings for at most 60 s."""

import asyncio

import pytest

from aegis_platform.tenant_settings import TenantSettingsCache


class Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def test_fr_ten_08_cache_ttl_shared_misses_and_invalidate() -> None:
    clock = Clock()
    calls = 0

    async def fetch(tenant_id: str) -> dict[str, object]:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0)
        return {"id": tenant_id, "n": calls}

    async def run() -> None:
        cache = TenantSettingsCache(fetch, clock=clock)
        a, b = await asyncio.gather(cache.get("t-1"), cache.get("t-1"))
        assert calls == 1
        assert a is b
        clock.t = 59.9
        assert (await cache.get("t-1"))["n"] == 1
        clock.t = 60.0
        assert (await cache.get("t-1"))["n"] == 2
        cache.invalidate("t-1")
        assert (await cache.get("t-1"))["n"] == 3

    asyncio.run(run())


def test_fr_ten_08_ttl_is_clamped_and_failures_are_not_cached() -> None:
    clock = Clock()
    fail = True

    async def fetch(tenant_id: str) -> dict[str, object]:
        if fail:
            raise RuntimeError("registry down")
        return {"id": tenant_id}

    async def run() -> None:
        nonlocal fail
        cache = TenantSettingsCache(fetch, ttl_seconds=600, clock=clock)
        with pytest.raises(RuntimeError):
            await cache.get("t-1")
        fail = False
        await cache.get("t-1")
        fail = True
        clock.t = 60.0
        with pytest.raises(RuntimeError):
            await cache.get("t-1")

    asyncio.run(run())
