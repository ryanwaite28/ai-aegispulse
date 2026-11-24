// Baseline collections, validators and indexes for the Events Service (PROJECT.md §7.6; FR-EVT, FR-RPL, FR-MSG).
// Immutable once committed (ADR-0005): add a new timestamped migration for any change.
const severity = { enum: ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"] };
const sensitivity = { enum: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED", "UNCLASSIFIED"] };
const status = { enum: ["INGESTED", "RULE_SCANNED", "AI_SCANNED", "CLASSIFIED", "OVERRIDDEN", "ARCHIVED", "REPLAYED"] };

const archiveValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "tenantId",
      "eventId",
      "correlationId",
      "eventType",
      "source",
      "schemaVersion",
      "occurredAt",
      "ingestedAt",
      "archivedAt",
      "idempotencyKey",
      "classification",
      "status",
      "statusHistory",
      "classificationHistory",
      "payload",
      "payloadSha256",
      "expireAt",
    ],
    properties: {
      tenantId: { bsonType: ["string", "null"] },
      eventId: { bsonType: "string" },
      correlationId: { bsonType: "string" },
      causationId: { bsonType: ["string", "null"] },
      eventType: { bsonType: "string" },
      exchange: { bsonType: "string" },
      routingKey: { bsonType: "string" },
      occurredAt: { bsonType: "date" },
      ingestedAt: { bsonType: "date" },
      archivedAt: { bsonType: "date" },
      expireAt: { bsonType: "date" },
      classification: {
        bsonType: "object",
        required: [
          "sensitivity",
          "algorithm_severity",
          "final_severity",
          "classification_source",
          "rule_version",
          "revision",
        ],
        properties: {
          sensitivity,
          publisher_stated_severity: { anyOf: [severity, { bsonType: "null" }] },
          algorithm_severity: severity,
          final_severity: severity,
          algorithm_confidence: { bsonType: ["double", "int", "null"] },
          classification_source: { enum: ["RULES", "AI_SCANNER", "ANALYST"] },
          revision: { bsonType: "int", minimum: 1 },
        },
      },
      status,
      statusHistory: { bsonType: "array" },
      classificationHistory: { bsonType: "array" },
      payload: { bsonType: "object" },
      redactions: { bsonType: "array" },
      payloadSha256: { bsonType: "string", pattern: "^[0-9a-f]{64}$" },
      pendingAiScan: { bsonType: "bool" },
      mentionedEntityIds: { bsonType: "array" },
    },
  },
};

const archiveIndexes = [
  { key: { tenantId: 1, eventId: 1 }, name: "ux_tenant_event", unique: true },
  { key: { tenantId: 1, correlationId: 1, occurredAt: -1 }, name: "ix_tenant_correlation_time" },
  { key: { tenantId: 1, "classification.final_severity": 1, occurredAt: -1 }, name: "ix_tenant_final_severity_time" },
  { key: { status: 1, occurredAt: 1 }, name: "ix_status_time" },
  { key: { tenantId: 1, eventType: 1, occurredAt: -1 }, name: "ix_tenant_type_time" },
  { key: { tenantId: 1, mentionedEntityIds: 1, occurredAt: -1 }, name: "ix_tenant_entity_time" },
  {
    key: { pendingAiScan: 1, archivedAt: 1 },
    name: "ix_pending_ai_scan",
    partialFilterExpression: { pendingAiScan: true },
  },
  { key: { expireAt: 1 }, name: "ttl_expire_at", expireAfterSeconds: 0 },
];

module.exports = {
  async up(db) {
    for (const name of ["events_archive", "events_restricted_audit"]) {
      await db.createCollection(name, {
        validator: archiveValidator,
        validationLevel: "strict",
        validationAction: "error",
      });
      await db.collection(name).createIndexes(archiveIndexes);
    }
    await db.createCollection("outbox");
    await db.collection("outbox").createIndexes([
      { key: { eventId: 1 }, name: "ux_event_id", unique: true },
      { key: { status: 1, availableAt: 1 }, name: "ix_status_available" },
      { key: { sentAt: 1 }, name: "ttl_sent_7d", expireAfterSeconds: 7 * 24 * 3600 },
    ]);
    await db.createCollection("processed_messages");
    await db.collection("processed_messages").createIndexes([
      { key: { consumer: 1, eventId: 1, replayGeneration: 1 }, name: "ux_consumer_event_generation", unique: true },
      { key: { processedAt: 1 }, name: "ttl_processed_14d", expireAfterSeconds: 14 * 24 * 3600 },
    ]);
    await db.createCollection("replay_jobs");
    await db.collection("replay_jobs").createIndexes([
      { key: { jobId: 1 }, name: "ux_job_id", unique: true },
      { key: { status: 1, createdAt: 1 }, name: "ix_status_created" },
      { key: { tenantId: 1, createdAt: -1 }, name: "ix_tenant_created" },
    ]);
    await db.createCollection("dead_letters");
    await db.collection("dead_letters").createIndexes([
      { key: { queue: 1, eventId: 1, lastFailedAt: 1 }, name: "ux_queue_event_failed", unique: true },
      { key: { tenantId: 1, status: 1, lastFailedAt: -1 }, name: "ix_tenant_status_failed" },
      { key: { errorCode: 1 }, name: "ix_error_code" },
    ]);
    await db.createCollection("leases");
    await db.collection("leases").createIndexes([{ key: { name: 1 }, name: "ux_lease_name", unique: true }]);
  },

  async down() {
    throw new Error("forward-only migrations (ADR-0005): write a new migration instead");
  },
};
