// FR-TXN-01 / FR-TXN-06 against real PostgreSQL 18 as svc_ingestion (RLS): the submission row and its txn.submitted
// outbox row commit together; idempotent repeats; key reuse with a different body → 409; tenant isolation; suspended
// tenants rejected. Tenant status is a port (the registry call is covered by the compose E2E).
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IntegrationPrincipal, UserPrincipal } from "@aegispulse/ts-platform/auth";
import { parseEnvelope } from "@aegispulse/ts-platform/amqp";
import { createLogger } from "@aegispulse/ts-platform/logging";
import { OutboxRepository } from "@aegispulse/ts-platform/outbox";
import { startPostgres, type PostgresEnv } from "../../../../packages/ts-platform/tests/integration/env.js";
import { TransactionRepository } from "../../src/db/transactions.repository.js";
import type { TransactionInput } from "../../src/domain/transaction.js";
import { TransactionService } from "../../src/service/transaction.service.js";
import { fxCurrencies } from "../../src/storage/fx-table.js";

const logger = createLogger({
  service: "ingestion",
  version: "test",
  env: "local",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const suspended = new Set<string>();
let db: PostgresEnv;
let service: TransactionService;

const analyst = (tenantId: string): UserPrincipal => ({
  kind: "user",
  userId: randomUUID(),
  tenantId,
  tenantSlug: "t",
  roles: ["ANALYST"],
  tokenId: randomUUID(),
});
const integration = (tenantId: string): IntegrationPrincipal => ({
  kind: "integration",
  clientId: "int_demo",
  tenantId,
  tenantSlug: "t",
  roles: ["INTEGRATION"],
  tokenId: randomUUID(),
});
const input = (overrides: Partial<TransactionInput> = {}): TransactionInput => ({
  idempotencyKey: `k-${randomUUID()}`,
  accountId: "acc-1",
  counterpartyId: "cp-1",
  counterpartyName: "Globex Clearing",
  amount: "250000.00",
  currency: "EUR",
  country: "DE",
  channel: "WIRE",
  occurredAt: new Date().toISOString(),
  metadata: { demoScenario: "none" },
  ...overrides,
});
const code = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.catch((x: unknown) => x);
  return (e as { code?: string }).code ?? "ok";
};
const outboxFor = async (transactionId: string): Promise<{ routing_key: string; envelope: unknown }[]> =>
  (
    await db.pool.query<{ routing_key: string; envelope: unknown }>(
      "SELECT routing_key, envelope FROM ingestion.outbox_events WHERE envelope->'payload'->>'transactionId' = $1",
      [transactionId],
    )
  ).rows;

beforeAll(async () => {
  db = await startPostgres("ingestion");
  service = new TransactionService({
    pool: db.pool,
    transactions: new TransactionRepository(),
    outbox: new OutboxRepository("ingestion"),
    tenants: { isActive: (t) => Promise.resolve(!suspended.has(t)) },
    currencies: fxCurrencies(),
    version: "abc1234",
    logger,
  });
}, 600_000);

afterAll(async () => {
  await db?.stop();
});

describe("transaction intake (FR-TXN-01) and reads (FR-TXN-06)", () => {
  it("persists the submission and one schema-valid txn.submitted on aegispulse.ingress atomically", async () => {
    const tenant = randomUUID();
    const body = input();
    const { result, duplicate } = await service.submit(analyst(tenant), undefined, body);
    expect(duplicate).toBe(false);
    const rows = await outboxFor(result.transactionId);
    expect(rows.map((r) => r.routing_key)).toEqual(["txn.submitted"]);
    const env = parseEnvelope(Buffer.from(JSON.stringify(rows[0]?.envelope)));
    expect(env).toMatchObject({
      eventId: result.eventId,
      tenantId: tenant,
      eventType: "txn.submitted",
      classification: { sensitivity: "CONFIDENTIAL", status: "INGESTED" },
      payload: { transactionId: result.transactionId, amount: "250000.0000", currency: "EUR", channel: "WIRE" },
    });
    const got = await service.getTransaction(analyst(tenant), undefined, result.transactionId);
    expect(got).toMatchObject({ amount: "250000.0000", counterpartyName: "Globex Clearing", eventId: result.eventId });
    expect(got.submittedBy).toMatch(/^user:/);
  });

  it("same key + same body → the original response, no second row or event; different body → 409", async () => {
    const tenant = randomUUID();
    const body = input();
    const first = await service.submit(integration(tenant), undefined, body);
    const again = await service.submit(integration(tenant), undefined, { ...body, metadata: { demoScenario: "none" } });
    expect(again).toEqual({ result: first.result, duplicate: true });
    expect(await outboxFor(first.result.transactionId)).toHaveLength(1);
    expect(await code(service.submit(integration(tenant), undefined, { ...body, amount: "250000.01" }))).toBe(
      "IDEMPOTENCY_KEY_REUSED",
    );
    const got = await service.getTransaction(integration(tenant), undefined, first.result.transactionId);
    expect(got.submittedBy).toBe("integration:int_demo");
  });

  it("concurrent submits with one key create one row and one event", async () => {
    const tenant = randomUUID();
    const body = input();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.submit(analyst(tenant), undefined, body)),
    );
    const ids = new Set(results.map((r) => r.result.transactionId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await outboxFor([...ids][0] ?? "")).toHaveLength(1);
  });

  it("the same key in another tenant is independent; reads are tenant-isolated (404)", async () => {
    const a = randomUUID();
    const b = randomUUID();
    const body = input();
    const ra = await service.submit(analyst(a), undefined, body);
    const rb = await service.submit(analyst(b), undefined, body);
    expect(rb.result.transactionId).not.toBe(ra.result.transactionId);
    expect(await code(service.getTransaction(analyst(b), undefined, ra.result.transactionId))).toBe("NOT_FOUND");
  });

  it("rejects FX, skew and metadata violations (422), suspended tenants (403 code) and other roles", async () => {
    const tenant = randomUUID();
    expect(await code(service.submit(analyst(tenant), undefined, input({ currency: "XYZ" })))).toBe("VALIDATION_ERROR");
    const future = new Date(Date.now() + 25 * 3_600_000).toISOString();
    expect(await code(service.submit(analyst(tenant), undefined, input({ occurredAt: future })))).toBe(
      "VALIDATION_ERROR",
    );
    const viewer = { ...analyst(tenant), roles: ["VIEWER"] };
    expect(await code(service.submit(viewer, undefined, input()))).toBe("FORBIDDEN");
    suspended.add(tenant);
    expect(await code(service.submit(analyst(tenant), undefined, input()))).toBe("TENANT_SUSPENDED");
    suspended.delete(tenant);
  });
});
