package io.aegispulse.cases.service;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** Request bodies of the internal cases actions (contract cases.internal.yaml). */
public final class Commands {
  private Commands() {}

  public record ScoreFactor(
      @NotBlank String name, @NotNull BigDecimal value, @NotNull BigDecimal contribution) {}

  public record WatchlistHit(
      @NotNull UUID watchlistId,
      @NotBlank String watchlistName,
      @NotNull @Pattern(regexp = "INFO|LOW|MEDIUM|HIGH|CRITICAL") String severityFloor,
      @NotNull UUID entityId,
      @Nullable String counterpartyId) {}

  /** recordRiskEvaluation (FR-TXN-05). */
  public record RecordRiskEvaluation(
      @NotNull UUID tenantId,
      @NotNull @Pattern(regexp = "^risk-eval:.+") @Size(max = 200) String idempotencyKey,
      @NotNull UUID transactionEventId,
      @NotNull UUID transactionId,
      @NotNull @Size(max = 64) String accountId,
      @NotNull @Size(max = 64) String counterpartyId,
      @NotNull @Min(0) @Max(100) Integer score,
      @NotNull @Pattern(regexp = "LOW|MEDIUM|HIGH|CRITICAL") String band,
      @NotNull List<@Valid ScoreFactor> factors,
      @NotBlank String modelVersion,
      @NotBlank String featureVersion,
      @Nullable List<@Valid WatchlistHit> watchlistHits,
      @Nullable @Pattern(regexp = "ACTIVE|SUSPENDED|DEACTIVATED") String tenantStatus) {}

  /** openCase (FR-CASE-01). */
  public record OpenCase(
      @NotNull UUID tenantId,
      @NotNull @Pattern(regexp = "TRANSACTION_RISK|DOCUMENT_RISK|EXTRACTION_REVIEW|CORRELATED")
          String caseType,
      @NotNull @Pattern(regexp = "LOW|MEDIUM|HIGH|CRITICAL") String severity,
      @NotNull UUID triggerEventId,
      @Nullable UUID triggerFileId,
      @Nullable List<UUID> primaryEntityIds,
      @NotBlank @Size(max = 200) String openIdempotencyKey,
      @Nullable UUID previousCaseId) {}

  public record GetTransactionEvaluation(@NotNull UUID transactionId) {}
}
