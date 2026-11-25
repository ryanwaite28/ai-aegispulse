import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { CanonicalEnvelope } from "@aegispulse/contracts/generated/ts/envelope.ts";
import { PoisonMessageError, TransientError } from "@aegispulse/ts-platform/errors";
import { createLogger } from "@aegispulse/ts-platform/logging";
import {
  ScoreTransactionSaga,
  type ScoreTransactionPorts,
  type TenantSettingsView,
  type WatchlistHit,
} from "./score-transaction.saga.js";

const logger = createLogger({
  service: "orchestrator",
  version: "test",
  env: "local",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const TENANT = randomUUID();

function envelope(
  overrides: Partial<CanonicalEnvelope> = {},
  payload: Record<string, unknown> = {},
): CanonicalEnvelope {
  return {
    eventId: randomUUID(),
    correlationId: `corr-${randomUUID()}`,
    causationId: null,
    tenantId: TENANT,
    schemaVersion: "1.0.0",
    eventType: "txn.submitted",
    source: "api:/v1/transactions",
    producer: "aegispulse-ingestion@abc1234",
    occurredAt: new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    idempotencyKey: "txn.submitted:x",
    classification: { sensitivity: "CONFIDENTIAL", status: "INGESTED" },
    payload: {
      transactionId: randomUUID(),
      accountId: "acc-1",
      counterpartyId: "cp-1",
      counterpartyName: "Globex Clearing",
      amount: "250000.0000",
      currency: "EUR",
      country: "DE",
      channel: "WIRE",
      occurredAt: new Date().toISOString(),
      metadata: { demoScenario: "FORCE_CRITICAL" },
      ...payload,
    },
    ...overrides,
  } as CanonicalEnvelope;
}

function ports(
  over: Partial<ScoreTransactionPorts> = {},
  settings: Partial<TenantSettingsView> = {},
  hits: WatchlistHit[] = [],
): { p: ScoreTransactionPorts; calls: { step: string; arg: unknown }[] } {
  const calls: { step: string; arg: unknown }[] = [];
  const p: ScoreTransactionPorts = {
    tenantSettings: (t) => {
      calls.push({ step: "settings", arg: t });
      return Promise.resolve({
        status: "ACTIVE",
        highValueThresholdUsd: "50000",
        highRiskCountries: ["IR"],
        demoMode: true,
        ...settings,
      });
    },
    checkWatchlists: (t, id, name) => {
      calls.push({ step: "watchlists", arg: { t, id, name } });
      return Promise.resolve(hits);
    },
    score: (r) => {
      calls.push({ step: "score", arg: r });
      return Promise.resolve({
        score: 85,
        band: "CRITICAL",
        factors: [{ name: "amount", value: 270000, contribution: 40 }],
        modelVersion: "risk-heuristic-v1.0.0",
        featureVersion: "features-v1+fx-static-v1",
      });
    },
    recordRiskEvaluation: (i) => {
      calls.push({ step: "record", arg: i });
      return Promise.resolve({ id: "ev-1", caseId: "case-1", suppressedReason: null });
    },
    ...over,
  };
  return { p, calls };
}

describe("ScoreTransactionSaga (FR-TXN-03)", () => {
  it("runs settings → watchlists → score → recordRiskEvaluation with the contract payloads", async () => {
    const hit: WatchlistHit = {
      watchlistId: randomUUID(),
      watchlistName: "Sanctions Watch",
      severityFloor: "HIGH",
      entityId: randomUUID(),
    };
    const { p, calls } = ports({}, {}, [hit]);
    const e = envelope();
    const r = await new ScoreTransactionSaga(p, logger).run(e);
    expect(r).toEqual({ id: "ev-1", caseId: "case-1", suppressedReason: null });
    expect(calls.map((c) => c.step)).toEqual(["settings", "watchlists", "score", "record"]);
    expect(calls[1]?.arg).toEqual({ t: TENANT, id: "cp-1", name: "Globex Clearing" });
    expect(calls[2]?.arg).toMatchObject({
      tenantId: TENANT,
      eventId: e.eventId,
      amount: "250000.0000",
      watchlistHit: true,
      metadata: { demoScenario: "FORCE_CRITICAL" },
      tenantSettings: { highValueThresholdUsd: "50000", highRiskCountries: ["IR"], demoMode: true },
    });
    expect(calls[3]?.arg).toMatchObject({
      tenantId: TENANT,
      idempotencyKey: `risk-eval:${e.eventId}`,
      transactionEventId: e.eventId,
      score: 85,
      band: "CRITICAL",
      tenantStatus: "ACTIVE",
      watchlistHits: [{ ...hit, counterpartyId: "cp-1" }],
    });
  });

  it("passes a suspended tenant's status so cases suppresses the case (FR-TXN-05, FR-TEN-02)", async () => {
    const { p, calls } = ports({}, { status: "SUSPENDED" });
    await new ScoreTransactionSaga(p, logger).run(envelope());
    expect(calls[3]?.arg).toMatchObject({ tenantStatus: "SUSPENDED", watchlistHits: [] });
    expect(calls[2]?.arg).toMatchObject({ watchlistHit: false });
  });

  it("treats wrong event types, tenantless or incomplete payloads as poison (DLQ, no retry)", async () => {
    const saga = new ScoreTransactionSaga(ports().p, logger);
    await expect(saga.run(envelope({ eventType: "file.uploaded" }))).rejects.toBeInstanceOf(PoisonMessageError);
    await expect(saga.run(envelope({ tenantId: null }))).rejects.toBeInstanceOf(PoisonMessageError);
    await expect(saga.run(envelope({}, { amount: "" }))).rejects.toBeInstanceOf(PoisonMessageError);
  });

  it("lets a dependency failure propagate for the kit to retry, without recording anything", async () => {
    const { p, calls } = ports({
      score: () => Promise.reject(new TransientError("DEPENDENCY_UNAVAILABLE", "risk-scoring timeout")),
    });
    await expect(new ScoreTransactionSaga(p, logger).run(envelope())).rejects.toBeInstanceOf(TransientError);
    expect(calls.map((c) => c.step)).toEqual(["settings", "watchlists"]);
  });
});
