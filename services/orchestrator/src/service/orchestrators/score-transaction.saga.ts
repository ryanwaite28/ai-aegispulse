// ScoreTransactionSaga (FR-TXN-03; spec FR-TXN-03-score-transaction-saga). Stateless; each step is idempotent:
//   txn.submitted → (1) tenant settings (registry getTenantSettings, cached ≤ 60 s, FR-TEN-08)
//                 → (2) checkWatchlists for the counterparty (registry)
//                 → (3) score (risk-scoring; 2 s timeout + circuit breaker; idempotent by eventId, FR-TXN-04)
//                 → (4) recordRiskEvaluation (cases; idempotencyKey risk-eval:{eventId}; tenantStatus for suppression)
// Failures surface as the kit's classes: dependency 5xx/timeout/breaker-open → TransientError (retry tiers, then DLQ);
// dependency 4xx → PermanentError (DLQ); a txn.submitted that is not one (no tenant, bad payload) → PoisonMessageError.
// No saga state is persisted: a redelivery re-runs every step and each step returns its first result.
import type { CanonicalEnvelope } from "@aegispulse/contracts/generated/ts/envelope.ts";
import { PoisonMessageError } from "@aegispulse/ts-platform/errors";
import type { Logger } from "@aegispulse/ts-platform/logging";

export interface TenantSettingsView {
  readonly status: "ACTIVE" | "SUSPENDED" | "DEACTIVATED";
  readonly highValueThresholdUsd: string;
  readonly highRiskCountries: readonly string[];
  readonly demoMode: boolean;
}

export interface WatchlistHit {
  readonly watchlistId: string;
  readonly watchlistName: string;
  readonly severityFloor: string;
  readonly entityId: string;
  readonly counterpartyId?: string | null;
}

export interface ScoreFactor {
  readonly name: string;
  readonly value: number;
  readonly contribution: number;
}

export interface ScoreResult {
  readonly score: number;
  readonly band: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly factors: readonly ScoreFactor[];
  readonly modelVersion: string;
  readonly featureVersion: string;
}

export interface RecordedEvaluation {
  readonly id: string;
  readonly caseId?: string | null;
  readonly suppressedReason?: string | null;
}

/** The saga's callees (typed internal clients, src/clients/). */
export interface ScoreTransactionPorts {
  tenantSettings(tenantId: string): Promise<TenantSettingsView>;
  checkWatchlists(tenantId: string, counterpartyId: string, counterpartyName: string): Promise<readonly WatchlistHit[]>;
  score(request: Record<string, unknown>): Promise<ScoreResult>;
  recordRiskEvaluation(input: Record<string, unknown>): Promise<RecordedEvaluation>;
}

interface TxnPayload {
  transactionId: string;
  accountId: string;
  counterpartyId: string;
  counterpartyName: string;
  amount: string;
  currency: string;
  country: string;
  channel: string;
  occurredAt: string;
  metadata?: Record<string, unknown>;
}

function txnPayload(envelope: CanonicalEnvelope): { tenantId: string; p: TxnPayload } {
  if (envelope.eventType !== "txn.submitted") {
    throw new PoisonMessageError("ENVELOPE_INVALID", `orchestrator.txn.q received ${envelope.eventType}`);
  }
  if (envelope.tenantId === null) throw new PoisonMessageError("ENVELOPE_INVALID", "txn.submitted without a tenant");
  const p = envelope.payload as Partial<TxnPayload>;
  for (const field of [
    "transactionId",
    "accountId",
    "counterpartyId",
    "counterpartyName",
    "amount",
    "currency",
    "country",
    "channel",
    "occurredAt",
  ] as const) {
    if (typeof p[field] !== "string" || p[field] === "") {
      throw new PoisonMessageError("ENVELOPE_INVALID", `txn.submitted payload lacks ${field}`);
    }
  }
  return { tenantId: envelope.tenantId, p: p as TxnPayload };
}

export class ScoreTransactionSaga {
  constructor(
    private readonly ports: ScoreTransactionPorts,
    private readonly logger: Logger,
  ) {}

  async run(envelope: CanonicalEnvelope): Promise<RecordedEvaluation> {
    const { tenantId, p } = txnPayload(envelope);
    const settings = await this.ports.tenantSettings(tenantId);
    const hits = await this.ports.checkWatchlists(tenantId, p.counterpartyId, p.counterpartyName);
    const scored = await this.ports.score({
      tenantId,
      eventId: envelope.eventId,
      accountId: p.accountId,
      counterpartyId: p.counterpartyId,
      amount: p.amount,
      currency: p.currency,
      country: p.country,
      channel: p.channel,
      occurredAt: p.occurredAt,
      metadata: p.metadata ?? {},
      watchlistHit: hits.length > 0,
      tenantSettings: {
        highValueThresholdUsd: settings.highValueThresholdUsd,
        highRiskCountries: [...settings.highRiskCountries],
        demoMode: settings.demoMode,
      },
    });
    const recorded = await this.ports.recordRiskEvaluation({
      tenantId,
      idempotencyKey: `risk-eval:${envelope.eventId}`,
      transactionEventId: envelope.eventId,
      transactionId: p.transactionId,
      accountId: p.accountId,
      counterpartyId: p.counterpartyId,
      score: scored.score,
      band: scored.band,
      factors: scored.factors,
      modelVersion: scored.modelVersion,
      featureVersion: scored.featureVersion,
      watchlistHits: hits.map((h) => ({
        watchlistId: h.watchlistId,
        watchlistName: h.watchlistName,
        severityFloor: h.severityFloor,
        entityId: h.entityId,
        counterpartyId: h.counterpartyId ?? p.counterpartyId,
      })),
      tenantStatus: settings.status,
    });
    if (recorded.suppressedReason != null) {
      this.logger.warn(
        { tenantId, eventId: envelope.eventId, suppressedReason: recorded.suppressedReason, score: scored.score },
        "case suppressed: tenant not active",
      );
    }
    this.logger.info(
      {
        tenantId,
        eventId: envelope.eventId,
        transactionId: p.transactionId,
        score: scored.score,
        band: scored.band,
        watchlistHits: hits.length,
        evaluationId: recorded.id,
        caseId: recorded.caseId ?? undefined,
      },
      "transaction.scored",
    );
    return recorded;
  }
}
