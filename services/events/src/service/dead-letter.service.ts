// Dead-letter registry (FR-MSG-02) and its admin actions (FR-MSG-03; spec FR-MSG-02-04).
// - recordDeadLetter (events.deadletter.q, raw consumer): upsert the OPEN record and, when a record opens, enqueue
//   ops.dead_letter.recorded in the same Mongo transaction. A dead-lettered ops.dead_letter.recorded is recorded but
//   not re-announced (no feedback loop through events.archive.q).
// - list/get: PLATFORM_ADMIN sees every tenant (X-Aegis-Tenant narrows it); TENANT_ADMIN sees the own tenant; another
//   tenant's record is 404 DEAD_LETTER_NOT_FOUND.
// - replay/discard (people only; the audit payload names the user): OPEN → REPLAYED|DISCARDED conditional on OPEN,
//   with ops.audit.dead_letter_resolved in the same transaction. Replay republishes the stored bytes through the
//   contract topology back into the original queue with x-retry-count = 0 before the transaction commits; if the
//   publish is not confirmed the record stays OPEN. Repeating the same resolution is a no-op returning the record.
import type { Principal } from "@aegispulse/ts-platform/auth";
import { PLATFORM_TENANT_ID } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { Logger } from "@aegispulse/ts-platform/logging";
import { getMeter } from "@aegispulse/ts-platform/telemetry";
import type { ClientSession, MongoClient } from "mongodb";
import {
  deadLetterFacts,
  isSameResolution,
  maskedContent,
  replayBody,
  replayHeaders,
  replayRefusal,
  type DeadLetterDelivery,
  type ResolveAction,
} from "../domain/dead-letter.js";
import {
  parseObjectId,
  type DeadLetterDoc,
  type DeadLetterKeyset,
  type DeadLetterRepository,
} from "../db/dead-letter.repository.js";
import type { MongoOutboxRepository } from "../db/outbox.repository.js";
import type { Redaction } from "../domain/classification/rules-v1.js";
import { deadLetterRecorded, deadLetterResolved } from "./events.js";
import { rolesFor } from "./roles.js";

const DEFAULT_LIMIT = 50;

/** What the admin API sees: stored content masked by rules-v1 (§1.4.2), with the redaction list. */
export type DeadLetterView = DeadLetterDoc & { readonly redactions: readonly Redaction[] };

function view(doc: DeadLetterDoc): DeadLetterView {
  return { ...doc, ...maskedContent(doc) };
}
const MAX_REASON = 500;

/** Republishes stored bytes back into a work queue (implemented over the contract topology in storage/). */
export interface DeadLetterReplayPort {
  canReplay(queue: string): boolean;
  republish(
    queue: string,
    message: {
      body: Buffer;
      headers: Record<string, unknown>;
      messageId?: string | undefined;
      correlationId?: string | undefined;
      type?: string | undefined;
    },
  ): Promise<void>;
}

export interface DeadLetterDeps {
  readonly client: MongoClient;
  readonly repo: DeadLetterRepository;
  readonly outbox: MongoOutboxRepository;
  readonly replay: DeadLetterReplayPort;
  readonly version: string;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export interface ListDeadLettersInput {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
  readonly queue?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | undefined;
}

type DeadLetterOp = "listDeadLetters" | "getDeadLetter" | "replayDeadLetter" | "discardDeadLetter";

interface Scope {
  /** undefined = every tenant (PLATFORM_ADMIN without X-Aegis-Tenant). */
  readonly tenantId: string | undefined;
  readonly actor: string;
  readonly userId: string | null;
}

/**
 * FR-MSG-03 visibility: the contract roles (PA, TA) must match; PLATFORM_ADMIN may narrow to one tenant with
 * X-Aegis-Tenant; everyone else is held to the own tenant and may not send the header.
 */
function scope(principal: Principal, actingTenant: string | undefined, op: DeadLetterOp): Scope {
  if (principal.kind === "service") throw new DomainError("FORBIDDEN", "this action requires a tenant principal");
  if (!principal.roles.some((r) => rolesFor(op).includes(r))) {
    throw new DomainError("FORBIDDEN", "role not allowed for this action");
  }
  const actor = principal.kind === "user" ? `user:${principal.userId}` : `integration:${principal.clientId}`;
  const userId = principal.kind === "user" ? principal.userId : null;
  if (principal.roles.includes("PLATFORM_ADMIN")) return { tenantId: actingTenant, actor, userId };
  if (actingTenant !== undefined) throw new DomainError("FORBIDDEN", "X-Aegis-Tenant is for PLATFORM_ADMIN only");
  return { tenantId: principal.tenantId, actor, userId };
}

const recordedCounter = (() => {
  let counter: ReturnType<ReturnType<typeof getMeter>["createCounter"]> | undefined;
  return () =>
    (counter ??= getMeter().createCounter("aegispulse_dead_letters_recorded_total", {
      description: "Dead-letter deliveries recorded by the registry (every occurrence), by original queue (FR-MSG-04)",
    }));
})();

export class DeadLetterService {
  private readonly now: () => Date;

  constructor(private readonly deps: DeadLetterDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  /**
   * Starts every queue's series at 0 so increase() over the FR-MSG-04 window also counts a queue's first dead letter
   * (a counter series that first appears at 1 has no earlier sample to increase from).
   */
  primeMetrics(queues: readonly string[]): void {
    for (const queue of queues) recordedCounter().add(0, { queue });
  }

  /** FR-MSG-02 (consumer action recordDeadLetter). Never rejects a body; store failures propagate (requeue). */
  async recordDeadLetter(delivery: DeadLetterDelivery): Promise<DeadLetterDoc> {
    const facts = deadLetterFacts(delivery);
    const at = this.now();
    const record = (): Promise<{ doc: DeadLetterDoc; created: boolean }> =>
      this.deps.client.withSession((session) =>
        session.withTransaction(async () => {
          const r = await this.deps.repo.recordFailure(session, facts, at);
          if (r.created && facts.eventType !== "ops.dead_letter.recorded") {
            await this.deps.outbox.enqueue(session, deadLetterRecorded(this.deps.version, r.doc), at);
          }
          return r;
        }),
      );
    // A concurrent delivery of the same failure may win the OPEN-uniqueness index; rerunning updates its record.
    const { doc, created } = await record().catch((error: unknown) => {
      if ((error as { code?: unknown }).code === 11000) return record();
      throw error;
    });
    recordedCounter().add(1, { queue: facts.queue });
    this.deps.logger.warn(
      {
        deadLetterId: doc._id.toHexString(),
        queue: doc.queue,
        errorCode: doc.errorCode,
        stackHash: doc.stackHash,
        retryCount: doc.retryCount,
        ...(doc.eventId === null ? {} : { eventId: doc.eventId }),
        ...(doc.tenantId === null ? {} : { tenantId: doc.tenantId }),
        created,
        occurrences: doc.occurrences,
      },
      "dead_letter.recorded",
    );
    return doc;
  }

  async listDeadLetters(
    principal: Principal,
    actingTenant: string | undefined,
    input: ListDeadLettersInput,
  ): Promise<Page<DeadLetterView>> {
    const s = scope(principal, actingTenant, "listDeadLetters");
    const limit = input.limit ?? DEFAULT_LIMIT;
    const rows = await this.deps.repo.list(
      {
        tenantId: s.tenantId,
        queue: input.queue,
        errorCode: input.errorCode,
        from: input.from === undefined ? undefined : new Date(input.from),
        to: input.to === undefined ? undefined : new Date(input.to),
      },
      input.cursor === undefined ? undefined : decodeCursor(input.cursor),
      limit + 1,
    );
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items: items.map(view),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor({ lastFailedAt: last.lastFailedAt, id: last._id })
          : undefined,
    };
  }

  async getDeadLetter(
    principal: Principal,
    actingTenant: string | undefined,
    deadLetterId: string,
  ): Promise<DeadLetterView> {
    const s = scope(principal, actingTenant, "getDeadLetter");
    return view(await this.load(deadLetterId, s.tenantId));
  }

  async replayDeadLetter(
    principal: Principal,
    actingTenant: string | undefined,
    deadLetterId: string,
  ): Promise<DeadLetterView> {
    const s = scope(principal, actingTenant, "replayDeadLetter");
    const userId = this.person(s);
    const current = await this.load(deadLetterId, s.tenantId);
    if (current.status !== "OPEN") return view(this.alreadyResolved(current, "REPLAYED", s.actor, null));
    const refusal = this.deps.replay.canReplay(current.queue)
      ? replayRefusal(current)
      : `queue ${current.queue} has no replay route in the topology`;
    if (refusal !== null) {
      throw new DomainError("VALIDATION_ERROR", "request failed validation", {
        details: [{ field: "deadLetterId", message: refusal }],
      });
    }
    const resolved = await this.resolve(current, "REPLAYED", s.actor, userId, null, async (doc) => {
      const envelope = doc.envelope;
      try {
        await this.deps.replay.republish(doc.queue, {
          body: replayBody(doc),
          headers: replayHeaders(doc.headers),
          // Poison has no eventId: a stable id per record lets a consumer recognise a repeated replay.
          messageId: doc.eventId ?? `dead-letter-${doc._id.toHexString()}`,
          correlationId: typeof envelope?.["correlationId"] === "string" ? envelope["correlationId"] : undefined,
          type: doc.eventType ?? undefined,
        });
      } catch (error: unknown) {
        throw new DomainError("DEPENDENCY_UNAVAILABLE", "the broker did not confirm the replay; try again", {
          cause: error,
        });
      }
    });
    return view(resolved);
  }

  async discardDeadLetter(
    principal: Principal,
    actingTenant: string | undefined,
    deadLetterId: string,
    reason: string,
  ): Promise<DeadLetterView> {
    const s = scope(principal, actingTenant, "discardDeadLetter");
    const userId = this.person(s);
    const why = reason.trim();
    if (why.length === 0 || why.length > MAX_REASON) {
      throw new DomainError("VALIDATION_ERROR", "request failed validation", {
        details: [{ field: "reason", message: `1–${String(MAX_REASON)} characters` }],
      });
    }
    const current = await this.load(deadLetterId, s.tenantId);
    if (current.status !== "OPEN") return view(this.alreadyResolved(current, "DISCARDED", s.actor, why));
    return view(await this.resolve(current, "DISCARDED", s.actor, userId, why, async () => {}));
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private person(s: Scope): string {
    if (s.userId === null) throw new DomainError("FORBIDDEN", "dead letters are resolved by people");
    return s.userId;
  }

  private async load(deadLetterId: string, tenantId: string | undefined): Promise<DeadLetterDoc> {
    const id = parseObjectId(deadLetterId);
    const doc = id === null ? null : await this.deps.repo.find(id, tenantId);
    if (doc === null) throw new DomainError("DEAD_LETTER_NOT_FOUND", "dead letter not found");
    return doc;
  }

  private alreadyResolved(
    doc: DeadLetterDoc,
    action: ResolveAction,
    actor: string,
    reason: string | null,
  ): DeadLetterDoc {
    if (isSameResolution(doc, action, actor, reason)) return doc;
    throw new DomainError("DEAD_LETTER_ALREADY_RESOLVED", `dead letter is already ${doc.status}`);
  }

  private async resolve(
    current: DeadLetterDoc,
    action: ResolveAction,
    actor: string,
    userId: string,
    reason: string | null,
    effect: (doc: DeadLetterDoc) => Promise<void>,
  ): Promise<DeadLetterDoc> {
    const at = this.now();
    const done = await this.resolveOnce(current, action, actor, userId, reason, at, effect);
    if (done === null) {
      // Another request resolved it between our read and the conditional update.
      const latest = await this.load(current._id.toHexString(), undefined);
      return this.alreadyResolved(latest, action, actor, reason);
    }
    this.deps.logger.info(
      {
        deadLetterId: done._id.toHexString(),
        queue: done.queue,
        action,
        actor,
        ...(done.tenantId === null ? {} : { tenantId: done.tenantId }),
      },
      action === "REPLAYED" ? "dead_letter.replayed" : "dead_letter.discarded",
    );
    return done;
  }

  /**
   * One explicitly driven transaction (not withTransaction, whose retries would re-run the replay publish):
   * conditional OPEN → action + audit outbox row, then the effect (replay publish, confirmed), then commit.
   * Before the effect ran, a TransientTransactionError reruns the attempt; after it, only the commit is retried
   * (UnknownTransactionCommitResult). A commit that still fails after a confirmed publish leaves the record OPEN with
   * the message already back on its queue: at-least-once, absorbed by the consumers' eventId dedup (NFR-02).
   */
  private async resolveOnce(
    current: DeadLetterDoc,
    action: ResolveAction,
    actor: string,
    userId: string,
    reason: string | null,
    at: Date,
    effect: (doc: DeadLetterDoc) => Promise<void>,
  ): Promise<DeadLetterDoc | null> {
    for (let attempt = 1; ; attempt++) {
      const session = this.deps.client.startSession();
      let effected = false;
      try {
        session.startTransaction();
        const doc = await this.deps.repo.resolve(session, current._id, action, actor, reason, at);
        if (doc === null) {
          await session.abortTransaction();
          return null;
        }
        await this.deps.outbox.enqueue(
          session,
          deadLetterResolved(this.deps.version, doc, action, userId, PLATFORM_TENANT_ID),
          at,
        );
        await effect(doc); // an unconfirmed replay publish throws here: abort, the record stays OPEN
        effected = true;
        await commitWithRetry(session);
        return doc;
      } catch (error: unknown) {
        if (session.inTransaction()) await session.abortTransaction().catch(() => undefined);
        if (!effected && attempt < MAX_TXN_ATTEMPTS && hasLabel(error, "TransientTransactionError")) continue;
        throw error;
      } finally {
        await session.endSession();
      }
    }
  }
}

const MAX_TXN_ATTEMPTS = 3;

function hasLabel(error: unknown, label: string): boolean {
  const e = error as { hasErrorLabel?: (l: string) => boolean };
  return typeof e.hasErrorLabel === "function" && e.hasErrorLabel(label);
}

async function commitWithRetry(session: ClientSession): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await session.commitTransaction();
      return;
    } catch (error: unknown) {
      if (attempt < MAX_TXN_ATTEMPTS && hasLabel(error, "UnknownTransactionCommitResult")) continue;
      throw error;
    }
  }
}

function encodeCursor(k: DeadLetterKeyset): string {
  return Buffer.from(`${k.lastFailedAt.toISOString()}|${k.id.toHexString()}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): DeadLetterKeyset {
  const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const oid = id === undefined ? null : parseObjectId(id);
  if (at === undefined || oid === null || Number.isNaN(Date.parse(at))) {
    throw new DomainError("VALIDATION_ERROR", "request failed validation", {
      details: [{ field: "cursor", message: "invalid cursor" }],
    });
  }
  return { lastFailedAt: new Date(at), id: oid };
}
