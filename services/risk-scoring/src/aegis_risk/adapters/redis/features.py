"""Risk-scoring feature store on Redis (PROJECT.md §7.7 ``feat:*``; ACL ``risk_scoring`` has no scripting or MULTI).

Idempotency without Lua (FR-TXN-04): the features are read first, then claimed with
``SET NX feat:seen:{tenantId}:{eventId} <snapshot> EX 48h``. Only the winner's snapshot counts: a redelivery (or a
concurrent duplicate) loses the SET NX and returns the stored snapshot, so the score is stable and velocity is not
inflated. The updates that follow are idempotent too (ZADD by eventId; last-seen only moves forward), so a crash
between the claim and the updates is repaired by the redelivery.
"""

import json

from redis.asyncio import Redis

from aegis_risk.domain.heuristic_v1 import NEW_COUNTERPARTY_WINDOW_MS, VELOCITY_WINDOW_MS
from aegis_risk.service.scoring import FeatureSnapshot

SEEN_TTL_S = 48 * 3600
VELOCITY_TTL_S = 2 * 3600
COUNTERPARTY_TTL_S = NEW_COUNTERPARTY_WINDOW_MS // 1000


class RedisFeatureStore:
    def __init__(self, redis: Redis) -> None:
        self._redis = redis

    async def observe(
        self, tenant_id: str, event_id: str, account_id: str, counterparty_id: str, occurred_ms: int
    ) -> FeatureSnapshot:
        seen_key = f"feat:seen:{tenant_id}:{event_id}"
        velocity_key = f"feat:txn1h:{tenant_id}:{account_id}"
        counterparty_key = f"feat:cp:{tenant_id}:{account_id}"

        stored = await self._redis.get(seen_key)
        if stored is None:
            in_window = await self._redis.zcount(velocity_key, occurred_ms - VELOCITY_WINDOW_MS, occurred_ms)
            own = await self._redis.zscore(velocity_key, event_id)
            already_counted = own is not None and occurred_ms - VELOCITY_WINDOW_MS <= own <= occurred_ms
            last_raw = await self._redis.hget(counterparty_key, counterparty_id)
            last = int(last_raw) if last_raw is not None else None
            snapshot = FeatureSnapshot(in_window - (1 if already_counted else 0) + 1, last)
            body = json.dumps({"txnCount1h": snapshot.txn_count_1h, "counterpartyLastSeenMs": last})
            if not await self._redis.set(seen_key, body, nx=True, ex=SEEN_TTL_S):
                stored = await self._redis.get(seen_key)
        if stored is not None:
            raw = json.loads(stored)
            snapshot = FeatureSnapshot(int(raw["txnCount1h"]), raw["counterpartyLastSeenMs"])

        await self._redis.zadd(velocity_key, {event_id: occurred_ms})
        # Trim relative to this transaction's own time: entries 2 h older can never fall in a later window
        # (wall-clock trimming would erase the history of backdated transactions).
        await self._redis.zremrangebyscore(velocity_key, "-inf", occurred_ms - VELOCITY_TTL_S * 1000)
        await self._redis.expire(velocity_key, VELOCITY_TTL_S)
        current = await self._redis.hget(counterparty_key, counterparty_id)
        if current is None or int(current) < occurred_ms:
            await self._redis.hset(counterparty_key, counterparty_id, str(occurred_ms))
        await self._redis.expire(counterparty_key, COUNTERPARTY_TTL_S)
        return snapshot
