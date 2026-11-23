"""Consumer dedup hook (NFR-02): ``processed_messages(consumer, event_id, replay_generation)`` marked in the same
transaction as the service's state change."""

import uuid

from psycopg import AsyncConnection

from aegis_platform.db import qualified


class ProcessedMessagesRepository:
    def __init__(self, schema: str) -> None:
        self._table = qualified(schema, "processed_messages")

    async def mark_processed(
        self, conn: AsyncConnection, consumer: str, event_id: uuid.UUID, replay_generation: int
    ) -> bool:
        """False when already processed: the caller skips its work and returns DUPLICATE."""
        cur = await conn.execute(
            f"INSERT INTO {self._table} (consumer, event_id, replay_generation) VALUES (%s, %s, %s) "  # noqa: S608
            "ON CONFLICT DO NOTHING",
            (consumer, event_id, replay_generation),
        )
        return cur.rowcount == 1

    async def purge(self, conn: AsyncConnection, days: int = 14) -> int:
        cur = await conn.execute(
            f"DELETE FROM {self._table} WHERE processed_at < now() - make_interval(days => %s)",  # noqa: S608
            (days,),
        )
        return cur.rowcount
