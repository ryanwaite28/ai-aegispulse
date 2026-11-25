// /v1/transactions (FR-TXN-01): transport only. The body is passed to ingestion, which validates it (422), checks the
// FX table and tenant status, and answers 202 for a new submission and for an idempotent repeat.
// GET /v1/transactions/{id} (FR-TXN-06) composes the submission (ingestion) with the latest evaluation (cases):
// ACCEPTED (no evaluation yet) · SCORED (evaluated, no case) · CASE_OPENED (evaluation linked to a case).
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { HttpStatusError } from "@aegispulse/ts-platform/http-client";
import { CASES, INGESTION } from "../../config.js";
import type { CasesClient, CasesSchemas } from "../../clients/cases.client.js";
import type { IngestionClient, IngestionSchemas } from "../../clients/ingestion.client.js";
import { Operation } from "../../common/guards/jwt-auth.guard.js";
import { success, type Success } from "../../common/mappers/envelope.js";
import { forwardFrom, objectBody, uuidParam } from "../../common/mappers/forward.js";

type H = Record<string, string | string[] | undefined>;

@Controller("v1/transactions")
export class TransactionsController {
  constructor(
    @Inject(INGESTION) private readonly ingestion: IngestionClient,
    @Inject(CASES) private readonly cases: CasesClient,
  ) {}

  @Operation("submitTransaction")
  @Post()
  @HttpCode(202)
  async submit(
    @Headers() headers: H,
    @Body() body: unknown,
  ): Promise<Success<IngestionSchemas["TransactionAccepted"]>> {
    const r = await this.ingestion.call<"submitTransaction", IngestionSchemas["TransactionAccepted"]>(
      "submitTransaction",
      objectBody(body) as IngestionSchemas["SubmitTransactionInput"],
      forwardFrom(headers, { tenant: true, idempotency: true }),
    );
    return success(r.data);
  }

  @Operation("getTransaction")
  @Get(":id")
  async get(@Headers() headers: H, @Param("id") id: string): Promise<Success<Record<string, unknown>>> {
    const transactionId = uuidParam(id, "id");
    const forward = forwardFrom(headers, { tenant: true });
    const submission = await this.ingestion.call<"getTransaction", IngestionSchemas["TransactionSubmission"]>(
      "getTransaction",
      { transactionId },
      forward,
    );
    let evaluation: CasesSchemas["RiskEvaluation"] | null = null;
    try {
      evaluation = (
        await this.cases.call<"getTransactionEvaluation", CasesSchemas["RiskEvaluation"]>(
          "getTransactionEvaluation",
          { transactionId },
          forward,
        )
      ).data;
    } catch (error: unknown) {
      if (!(error instanceof HttpStatusError && error.status === 404)) throw error; // not scored yet
    }
    const caseId = evaluation?.caseId ?? null;
    return success({
      submission: submission.data,
      processingStatus: evaluation === null ? "ACCEPTED" : caseId === null ? "SCORED" : "CASE_OPENED",
      latestEvaluation: evaluation,
      caseId,
    });
  }
}
