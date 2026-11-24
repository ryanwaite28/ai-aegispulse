import { describe, expect, it } from "vitest";
import type { CanonicalEnvelope } from "@aegispulse/contracts/generated/ts/envelope.ts";
import { sha256Hex } from "../idempotency/index.js";
import { OUTBOX_MAX_BACKOFF_SECONDS, OutboxRepository, outboxBackoffSeconds, quoteSchema } from "./index.js";

describe("outbox policy (PROJECT.md §6.6)", () => {
  it("backs off 2^attempts seconds, capped at 5 minutes", () => {
    expect([1, 2, 5, 8, 9, 20].map(outboxBackoffSeconds)).toEqual([
      2,
      4,
      32,
      256,
      OUTBOX_MAX_BACKOFF_SECONDS,
      OUTBOX_MAX_BACKOFF_SECONDS,
    ]);
  });

  it("only accepts fixed schema identifiers", () => {
    expect(quoteSchema("ingestion")).toBe('"ingestion"');
    expect(() => new OutboxRepository("files; drop table x")).toThrow(TypeError);
  });

  it("refuses a routing key that differs from eventType (§6.7)", async () => {
    const repo = new OutboxRepository("files");
    const tx = { query: async () => ({ rows: [], rowCount: 1 }) };
    const envelope = { eventId: "e", eventType: "file.uploaded", tenantId: null } as unknown as CanonicalEnvelope;
    await expect(
      repo.enqueue(tx, { exchange: "aegispulse.ingress", routingKey: "file.deleted", envelope }),
    ).rejects.toThrow(TypeError);
  });
});

describe("sha256Hex (NFR-02 request hash)", () => {
  it("hashes strings and bytes identically", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(Buffer.from("abc"))).toBe(sha256Hex("abc"));
  });
});
