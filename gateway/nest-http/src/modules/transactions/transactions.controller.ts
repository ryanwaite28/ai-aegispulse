// /v1/transactions (FR-TXN-01): transport only. The body is passed to ingestion, which validates it (422), checks the
// FX table and tenant status, and answers 202 for a new submission and for an idempotent repeat.
// GET /v1/transactions/{id} (FR-TXN-06) composes ingestion + cases and lands with the cases slice (Phase 8c).
import { Body, Controller, Headers, HttpCode, Inject, Post } from "@nestjs/common";
import { INGESTION } from "../../config.js";
import type { IngestionClient, IngestionSchemas } from "../../clients/ingestion.client.js";
import { Operation } from "../../common/guards/jwt-auth.guard.js";
import { success, type Success } from "../../common/mappers/envelope.js";
import { forwardFrom, objectBody } from "../../common/mappers/forward.js";

type H = Record<string, string | string[] | undefined>;

@Controller("v1/transactions")
export class TransactionsController {
  constructor(@Inject(INGESTION) private readonly ingestion: IngestionClient) {}

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
}
