// ScoreTransactionPorts over the typed internal clients (§6.5): registry (settings + watchlists), risk-scoring
// (2 s timeout + breaker), cases. Each call carries the orchestrator's SERVICE token (svc-orchestrator, §5.7.4).
import type { InternalServiceClient } from "@aegispulse/ts-platform/http-client";
import type { TenantSettingsCache } from "@aegispulse/ts-platform/tenant-settings";
import type {
  RecordedEvaluation,
  ScoreResult,
  ScoreTransactionPorts,
  TenantSettingsView,
  WatchlistHit,
} from "../service/orchestrators/score-transaction.saga.js";

export class SagaClients implements ScoreTransactionPorts {
  constructor(
    private readonly settings: TenantSettingsCache,
    private readonly registry: InternalServiceClient<"registry">,
    private readonly scoring: InternalServiceClient<"riskScoring">,
    private readonly cases: InternalServiceClient<"cases">,
  ) {}

  async tenantSettings(tenantId: string): Promise<TenantSettingsView> {
    const t = await this.settings.get(tenantId);
    return {
      status: t.status,
      highValueThresholdUsd: t.highValueThresholdUsd,
      highRiskCountries: t.highRiskCountries,
      demoMode: t.demoMode,
    };
  }

  async checkWatchlists(
    tenantId: string,
    counterpartyId: string,
    counterpartyName: string,
  ): Promise<readonly WatchlistHit[]> {
    const r = await this.registry.invoke<"checkWatchlists", { hits: WatchlistHit[] }>("checkWatchlists", {
      tenantId,
      counterpartyRefs: [{ counterpartyId, counterpartyName }],
    });
    return r.hits;
  }

  score(request: Record<string, unknown>): Promise<ScoreResult> {
    return this.scoring.invoke<"score", ScoreResult>("score", request as never);
  }

  recordRiskEvaluation(input: Record<string, unknown>): Promise<RecordedEvaluation> {
    return this.cases.invoke<"recordRiskEvaluation", RecordedEvaluation>("recordRiskEvaluation", input as never);
  }
}
