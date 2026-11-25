// Internal transaction actions (§6.2 ingestion.submitTransaction / getTransaction; gateway with the user or
// integration token). Transport only: authenticate → validate shape (contract SubmitTransactionInput) → one service
// call → §8.2 envelope. 202 for a new submission and for an idempotent repeat (same original response, FR-TXN-01).
import type { JwtVerifier, Principal } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { HttpServer } from "@aegispulse/ts-platform/http";
import { getContext } from "@aegispulse/ts-platform/logging";
import { z } from "zod";
import type { TransactionRecord } from "../../db/transactions.repository.js";
import type { TransactionService } from "../../service/transaction.service.js";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const submit = z
  .object({
    idempotencyKey: z.string().min(1).max(128),
    accountId: z.string().min(1).max(64),
    counterpartyId: z.string().min(1).max(64),
    counterpartyName: z.string().min(1).max(200),
    amount: z.string().regex(/^(?=.*[1-9])[0-9]{1,18}\.[0-9]{2,4}$/, "decimal string > 0 with 2–4 decimals"),
    currency: z.string().regex(/^[A-Z]{3}$/),
    country: z.string().regex(/^[A-Z]{2}$/),
    channel: z.enum(["WIRE", "ACH", "CARD", "CRYPTO", "INTERNAL"]),
    occurredAt: z.iso.datetime({ offset: true }),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const getOne = z.object({ transactionId: uuid }).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (r.success) return r.data;
  throw new DomainError("VALIDATION_ERROR", "request failed validation", {
    details: r.error.issues.map((i) => ({ field: i.path.join(".") || "body", message: i.message })),
  });
}

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const v = headers[name];
  return typeof v === "string" ? v : undefined;
}

function meta(): Record<string, string> {
  const ctx = getContext();
  return {
    ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
    ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
  };
}

/** Contract TransactionSubmission (no idempotency key or request hash). */
export function transactionView(t: TransactionRecord): Record<string, unknown> {
  return {
    id: t.id,
    eventId: t.eventId,
    correlationId: t.correlationId,
    accountId: t.accountId,
    counterpartyId: t.counterpartyId,
    counterpartyName: t.counterpartyName,
    amount: t.amount,
    currency: t.currency,
    country: t.country,
    channel: t.channel,
    occurredAt: t.occurredAt.toISOString(),
    metadata: t.metadata,
    sourceFileId: t.sourceFileId,
    sourceRow: t.sourceRow,
    submittedBy: t.submittedBy,
    createdAt: t.createdAt.toISOString(),
  };
}

export function registerTransactionRoutes(app: HttpServer, verifier: JwtVerifier, service: TransactionService): void {
  const auth = (headers: Record<string, unknown>, action: string): Promise<Principal> =>
    verifier.authorizeInternal(header(headers, "authorization"), `ingestion.${action}`);

  app.post("/internal/v1/submitTransaction", async (req, reply) => {
    const principal = await auth(req.headers, "submitTransaction");
    const { result } = await service.submit(principal, header(req.headers, "x-aegis-tenant"), parse(submit, req.body));
    return reply.code(202).send({ data: result, meta: meta() });
  });

  app.post("/internal/v1/getTransaction", async (req) => {
    const principal = await auth(req.headers, "getTransaction");
    const input = parse(getOne, req.body);
    return {
      data: transactionView(
        await service.getTransaction(principal, header(req.headers, "x-aegis-tenant"), input.transactionId),
      ),
      meta: meta(),
    };
  });
}
