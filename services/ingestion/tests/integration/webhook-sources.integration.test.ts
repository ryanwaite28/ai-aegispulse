// FR-WHK-01/07 against real PostgreSQL 18 (migrated by the migrate image; the pool connects as svc_ingestion, so RLS
// and grants apply as in production). Reuses the ts-platform integration environment.
import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserPrincipal } from "@aegispulse/ts-platform/auth";
import { IdempotencyRepository } from "@aegispulse/ts-platform/idempotency";
import { createLogger } from "@aegispulse/ts-platform/logging";
import { OutboxRepository, withTenantTransaction } from "@aegispulse/ts-platform/outbox";
import { startPostgres, type PostgresEnv } from "../../../../packages/ts-platform/tests/integration/env.js";
import { WebhookSourceRepository } from "../../src/db/webhook-sources.repository.js";
import { open, parseKek } from "../../src/domain/crypto.js";
import { WebhookSourceService } from "../../src/service/webhook-source.service.js";

const logger = createLogger({
  service: "ingestion",
  version: "test",
  env: "local",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const kek = parseKek(randomBytes(32).toString("base64"), 1);
let db: PostgresEnv;
const clock = new Date("2026-11-24T10:00:00Z");
let service: WebhookSourceService;

const ta = (tenantId: string, roles = ["TENANT_ADMIN"]): UserPrincipal => ({
  kind: "user",
  userId: randomUUID(),
  tenantId,
  tenantSlug: "t",
  roles,
  tokenId: randomUUID(),
});

const code = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.catch((x: unknown) => x);
  return (e as { code?: string }).code ?? `no error: ${JSON.stringify(e)}`;
};

beforeAll(async () => {
  db = await startPostgres("ingestion");
  service = new WebhookSourceService({
    pool: db.pool,
    sources: new WebhookSourceRepository(),
    outbox: new OutboxRepository("ingestion"),
    idempotency: new IdempotencyRepository("ingestion"),
    kek,
    version: "abc1234",
    logger,
    now: () => clock,
  });
}, 600_000);

afterAll(async () => {
  await db?.stop();
});

describe("webhook sources (FR-WHK-01/07)", () => {
  it("FR-WHK-01 creates a source with a once-shown secret stored only as envelope-encrypted bytes", async () => {
    const tenant = randomUUID();
    const created = await service.create(ta(tenant), undefined, {
      sourceKey: "acme-wire",
      displayName: "ACME wire",
      allowedAttachmentHosts: ["Files.Example.com", "files.example.com"],
    });
    expect(created).toMatchObject({ sourceKey: "acme-wire", trustLevel: "UNTRUSTED", status: "ACTIVE" });
    expect(created.allowedAttachmentHosts).toEqual(["files.example.com"]);
    expect(created.signingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const rows = await withTenantTransaction(db.pool, tenant, (tx) =>
      tx.query<{ slot: string; ciphertext: Buffer; wrapped_data_key: Buffer; nonce: Buffer; kek_version: number }>(
        "SELECT slot, ciphertext, wrapped_data_key, nonce, kek_version FROM ingestion.webhook_secrets WHERE source_id = $1",
        [created.id],
      ),
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0];
    expect(row?.ciphertext.includes(Buffer.from(created.signingSecret))).toBe(false);
    expect(
      open(
        {
          ciphertext: row?.ciphertext ?? Buffer.alloc(0),
          wrappedDataKey: row?.wrapped_data_key ?? Buffer.alloc(0),
          nonce: row?.nonce ?? Buffer.alloc(0),
          kekVersion: row?.kek_version ?? 0,
        },
        kek,
      ),
    ).toBe(created.signingSecret);
    const listed = await service.list(ta(tenant), {});
    expect(JSON.stringify(listed)).not.toContain(created.signingSecret);
  });

  it("FR-WHK-01 sourceKey is globally unique (across tenants, and after deletion); bad hosts and roles refused", async () => {
    const a = randomUUID();
    const b = randomUUID();
    const s = await service.create(ta(a), undefined, { sourceKey: "shared-key", displayName: "A" });
    expect(await code(service.create(ta(b), undefined, { sourceKey: "shared-key", displayName: "B" }))).toBe(
      "WEBHOOK_SOURCE_KEY_TAKEN",
    );
    await service.remove(ta(a), s.id);
    expect(await code(service.create(ta(a), undefined, { sourceKey: "shared-key", displayName: "A2" }))).toBe(
      "WEBHOOK_SOURCE_KEY_TAKEN",
    );
    expect(
      await code(
        service.create(ta(a), undefined, {
          sourceKey: "hosts-x",
          displayName: "x",
          allowedAttachmentHosts: ["https://e.com/x"],
        }),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(await code(service.create(ta(a, ["ANALYST"]), undefined, { sourceKey: "role-x", displayName: "x" }))).toBe(
      "FORBIDDEN",
    );
  });

  it("FR-WHK-07 rotation keeps the previous secret for 72 h; a repeated Idempotency-Key never replays a secret", async () => {
    const tenant = randomUUID();
    const s = await service.create(ta(tenant), "k-create", { sourceKey: "rotating", displayName: "R" });
    expect(await code(service.create(ta(tenant), "k-create", { sourceKey: "rotating", displayName: "R" }))).toBe(
      "IDEMPOTENCY_KEY_REUSED",
    );
    const rotated = await service.rotate(ta(tenant), undefined, s.id);
    expect(rotated.signingSecret).not.toBe(s.signingSecret);
    expect(rotated.previousSecretExpiresAt).toBe(new Date(clock.getTime() + 72 * 3600 * 1000).toISOString());
    const slots = await withTenantTransaction(db.pool, tenant, (tx) =>
      tx.query<{ slot: string; ciphertext: Buffer; wrapped_data_key: Buffer; nonce: Buffer; kek_version: number }>(
        "SELECT slot, ciphertext, wrapped_data_key, nonce, kek_version FROM ingestion.webhook_secrets WHERE source_id = $1 ORDER BY slot",
        [s.id],
      ),
    );
    const plain = Object.fromEntries(
      slots.rows.map((r) => [
        r.slot,
        open(
          { ciphertext: r.ciphertext, wrappedDataKey: r.wrapped_data_key, nonce: r.nonce, kekVersion: r.kek_version },
          kek,
        ),
      ]),
    );
    expect(plain).toEqual({ CURRENT: rotated.signingSecret, PREVIOUS: s.signingSecret });
    await service.rotate(ta(tenant), undefined, s.id); // a second rotation replaces the PREVIOUS slot
    expect(
      (
        await withTenantTransaction(db.pool, tenant, (tx) =>
          tx.query("SELECT 1 FROM ingestion.webhook_secrets WHERE source_id = $1", [s.id]),
        )
      ).rowCount,
    ).toBe(2);
  });

  it("FR-WHK-07 trust-level changes are audited through the outbox; other tenants see 404", async () => {
    const tenant = randomUUID();
    const s = await service.create(ta(tenant), undefined, { sourceKey: "trusty", displayName: "T" });
    const updated = await service.update(ta(tenant), undefined, {
      sourceId: s.id,
      trustLevel: "TRUSTED",
      displayName: "Trusty",
    });
    expect(updated).toMatchObject({ trustLevel: "TRUSTED", displayName: "Trusty" });
    await service.update(ta(tenant), undefined, { sourceId: s.id, displayName: "Renamed" }); // no trust change → no event
    const events = await db.pool.query<{
      routing_key: string;
      exchange: string;
      envelope: { payload: Record<string, unknown>; tenantId: string };
    }>(
      "SELECT routing_key, exchange, envelope FROM ingestion.outbox_events WHERE envelope->'payload'->>'sourceId' = $1",
      [s.id],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      routing_key: "ops.audit.source_trust_changed",
      exchange: "aegispulse.intelligence",
      envelope: { tenantId: tenant, payload: { sourceKey: "trusty", before: "UNTRUSTED", after: "TRUSTED" } },
    });
    const other = randomUUID();
    expect(await code(service.update(ta(other), undefined, { sourceId: s.id, displayName: "x" }))).toBe("NOT_FOUND");
    expect(await code(service.rotate(ta(other), undefined, s.id))).toBe("NOT_FOUND");
    expect(await code(service.remove(ta(other), s.id))).toBe("NOT_FOUND");
    expect((await service.list(ta(other), {})).items).toHaveLength(0);
  });
});
