// FR-MSG-02: at most one OPEN dead_letters record per (queue, failing message). Two deliveries of the same failure can
// be recorded concurrently (prefetch > 1); a partial unique index makes the "one OPEN record" rule hold, and the
// repository retries the losing upsert as an update. identityKey = eventId, or "sha256:{bodySha256}" for bodies
// without one. Backfills records written before this migration (Phase 7 local stacks), then builds the index.
module.exports = {
  async up(db) {
    const col = db.collection("dead_letters");
    await col.updateMany({ identityKey: { $exists: false } }, [
      {
        $set: {
          identityKey: {
            $cond: [
              { $eq: [{ $ifNull: ["$eventId", null] }, null] },
              { $concat: ["sha256:", "$bodySha256"] },
              "$eventId",
            ],
          },
        },
      },
    ]);
    await col.createIndex(
      { queue: 1, identityKey: 1 },
      { name: "ux_open_queue_identity", unique: true, partialFilterExpression: { status: "OPEN" } },
    );
  },

  async down() {
    throw new Error("forward-only migrations (ADR-0005): write a new migration instead");
  },
};
