// Transaction intake (FR-TXN-01) and reads (FR-TXN-06; spec FR-TXN-01-06-transaction-intake).
// - submit: contract roles (INTEGRATION, ANALYST, TENANT_ADMIN, PLATFORM_ADMIN via X-Aegis-Tenant) → tenant ACTIVE
//   (else TENANT_SUSPENDED) → FX currency / future skew / metadata size (422) → one tenant transaction: the row
//   (idempotent on (tenant, idempotencyKey)) + outbox txn.submitted. The same key with the same canonical body returns
//   the original {transactionId, eventId}; with a different body → 409 IDEMPOTENCY_KEY_REUSED.
// - getTransaction: the submission in the caller's tenant (404 NOT_FOUND otherwise); processing status,
//   evaluation and case are composed by the gateway from cases (FR-TXN-06).
import type { Principal } from "@aegispulse/ts-platform/auth";
import { tenantAccess } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import { uuidv7 } from "@aegispulse/ts-platform/ids";
import type { Logger } from "@aegispulse/ts-platform/logging";
import type { OutboxRepository } from "@aegispulse/ts-platform/outbox";
import { withTenantTransaction, type SqlPool } from "@aegispulse/ts-platform/outbox";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GatewayOperationId, GatewayRoute } from "@aegispulse/contracts/generated/ts/gateway-routes.ts";
import { intakeViolations, requestHash, type TransactionInput } from "../domain/transaction.js";
import type { TransactionRecord, TransactionRepository } from "../db/transactions.repository.js";
import { correlationId, txnSubmitted } from "./events.js";
import type { TenantStatusPort } from "./orchestrators/ingest-webhook.usecase.js";

const ROUTES = JSON.parse(
  readFileSync(fileURLToPath(import.meta.resolve("@aegispulse/contracts/gateway-routes")), "utf8"),
) as Record<GatewayOperationId, GatewayRoute>;

export interface TransactionAccepted {
  readonly transactionId: string;
  readonly eventId: string;
}

export interface TransactionServiceDeps {
  readonly pool: SqlPool;
  readonly transactions: TransactionRepository;
  readonly outbox: OutboxRepository;
  readonly tenants: TenantStatusPort;
  readonly currencies: ReadonlySet<string>;
  readonly version: string;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export class TransactionService {
  private readonly now: () => Date;

  constructor(private readonly deps: TransactionServiceDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  async submit(
    principal: Principal,
    actingTenant: string | undefined,
    input: TransactionInput,
  ): Promise<{ result: TransactionAccepted; duplicate: boolean }> {
    const access = tenantAccess(principal, actingTenant, ROUTES.submitTransaction.roles);
    if (!(await this.deps.tenants.isActive(access.tenantId))) {
      throw new DomainError("TENANT_SUSPENDED", "tenant is suspended or deactivated");
    }
    const violations = intakeViolations(input, this.now(), this.deps.currencies);
    if (violations.length > 0) {
      throw new DomainError("VALIDATION_ERROR", "request failed validation", { details: violations });
    }
    const hash = requestHash(input);
    const outcome = await withTenantTransaction(this.deps.pool, access.tenantId, async (tx) => {
      const existing = await this.deps.transactions.findByIdempotencyKey(tx, access.tenantId, input.idempotencyKey);
      if (existing !== null) return { record: existing, duplicate: true };
      const id = uuidv7();
      const eventId = uuidv7();
      const inserted = await this.deps.transactions.insert(tx, {
        id,
        tenantId: access.tenantId,
        idempotencyKey: input.idempotencyKey,
        requestSha256: hash,
        eventId,
        correlationId: correlationId(eventId),
        accountId: input.accountId,
        counterpartyId: input.counterpartyId,
        counterpartyName: input.counterpartyName,
        amount: input.amount,
        currency: input.currency,
        country: input.country,
        channel: input.channel,
        occurredAt: new Date(input.occurredAt),
        metadata: { ...(input.metadata ?? {}) },
        submittedBy: access.actor,
      });
      if (inserted === null) {
        // A concurrent submit with the same key won; its row is visible once it commits (the unique index waited).
        const winner = await this.deps.transactions.findByIdempotencyKey(tx, access.tenantId, input.idempotencyKey);
        if (winner === null) throw new DomainError("CONFLICT", "concurrent submission; retry");
        return { record: winner, duplicate: true };
      }
      await this.deps.outbox.enqueue(
        tx,
        txnSubmitted({
          version: this.deps.version,
          tenantId: access.tenantId,
          eventId: inserted.eventId,
          correlationId: inserted.correlationId,
          transaction: inserted,
        }),
      );
      return { record: inserted, duplicate: false };
    });
    if (outcome.duplicate && outcome.record.requestSha256 !== hash) {
      throw new DomainError("IDEMPOTENCY_KEY_REUSED", "idempotency key was used with a different request body");
    }
    const r = outcome.record;
    if (!outcome.duplicate) {
      this.deps.logger.info(
        { tenantId: r.tenantId, transactionId: r.id, eventId: r.eventId, channel: r.channel, actor: access.actor },
        "transaction.submitted",
      );
    }
    return { result: { transactionId: r.id, eventId: r.eventId }, duplicate: outcome.duplicate };
  }

  async getTransaction(
    principal: Principal,
    actingTenant: string | undefined,
    transactionId: string,
  ): Promise<TransactionRecord> {
    const access = tenantAccess(principal, actingTenant, ROUTES.getTransaction.roles);
    const record = await withTenantTransaction(this.deps.pool, access.tenantId, (tx) =>
      this.deps.transactions.findById(tx, access.tenantId, transactionId),
    );
    if (record === null) throw new DomainError("NOT_FOUND", "transaction not found");
    return record;
  }
}
