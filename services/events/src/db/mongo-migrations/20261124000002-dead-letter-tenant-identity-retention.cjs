// FR-MSG-02/03 security review: (1) the OPEN identity includes the tenant ("{tenantId|-}|{eventId | sha256:{hash}}"),
// so a dead letter naming another tenant can never overwrite an existing tenant's record; (2) resolved records expire
// 30 days after resolution (TTL on expireAt; OPEN records carry none and are kept until resolved). Recomputes the key
// for records written before this migration and stamps expireAt on already-resolved ones.
module.exports = {
  async up(db) {
    const col = db.collection("dead_letters");
    await col.updateMany({}, [
      {
        $set: {
          identityKey: {
            $concat: [
              { $ifNull: ["$tenantId", "-"] },
              "|",
              { $ifNull: ["$eventId", { $concat: ["sha256:", "$bodySha256"] }] },
            ],
          },
        },
      },
    ]);
    await col.updateMany({ status: { $ne: "OPEN" }, resolvedAt: { $type: "date" } }, [
      { $set: { expireAt: { $dateAdd: { startDate: "$resolvedAt", unit: "day", amount: 30 } } } },
    ]);
    await col.createIndex({ expireAt: 1 }, { name: "ttl_resolved_expire_at", expireAfterSeconds: 0 });
  },

  async down() {
    throw new Error("forward-only migrations (ADR-0005): write a new migration instead");
  },
};
