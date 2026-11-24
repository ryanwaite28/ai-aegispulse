// overrideClassification (FR-CLS-07; spec FR-EVT-CLS §2 "Analyst override"). ANALYST+ (contract roles):
//   justification ≥ 20 chars (trimmed) else 422 CLASSIFICATION_JUSTIFICATION_REQUIRED; standard tier only (analysts
//   cannot see restricted events, so overriding one by id is 404, like reading it);
//   in one Mongo transaction, conditional on classification.revision: set final_severity and/or sensitivity,
//   classification_source ANALYST, revision + 1, status OVERRIDDEN, append statusHistory + classificationHistory
//   (actor, justification), clear pendingAiScan (an override is final, §1.4.3), and enqueue classification.overridden.
//   Raising sensitivity to RESTRICTED moves the record to events_restricted_audit (7-year expiry), as FR-CLS-05.
//   The only automated-path exception to elevate-only: an analyst may lower severity (ADR-0008).
//   A repeat of the same override (same values, actor and justification) is a no-op returning the record.
import type { Principal } from "@aegispulse/ts-platform/auth";
import { tenantAccess } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { Logger } from "@aegispulse/ts-platform/logging";
import type { MongoClient } from "mongodb";
import type { Sensitivity, Severity } from "../domain/classification/severity.js";
import { expireAt } from "../domain/retention.js";
import type { ArchivedEvent, ArchiveRepository } from "../db/archive.repository.js";
import type { MongoOutboxRepository } from "../db/outbox.repository.js";
import { classificationOverridden } from "./events.js";
import { rolesFor } from "./roles.js";
import type { TieredEvent } from "./event-query.service.js";

export const MIN_JUSTIFICATION = 20;
export const OVERRIDE_VERSION = "analyst-override";
const MAX_ATTEMPTS = 3;

export interface OverrideInput {
  readonly eventId: string;
  readonly finalSeverity?: Severity | undefined;
  readonly sensitivity?: Sensitivity | undefined;
  readonly justification: string;
}

export interface OverrideDeps {
  readonly client: MongoClient;
  readonly archive: ArchiveRepository;
  readonly outbox: MongoOutboxRepository;
  readonly version: string;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export class OverrideService {
  private readonly now: () => Date;

  constructor(private readonly deps: OverrideDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  async overrideClassification(
    principal: Principal,
    actingTenant: string | undefined,
    input: OverrideInput,
  ): Promise<TieredEvent> {
    const access = tenantAccess(principal, actingTenant, rolesFor("overrideEventClassification"));
    const actorId = access.userId;
    if (actorId === null) throw new DomainError("FORBIDDEN", "overrides are made by people");
    const justification = input.justification.trim();
    if (justification.length < MIN_JUSTIFICATION) {
      throw new DomainError(
        "CLASSIFICATION_JUSTIFICATION_REQUIRED",
        `a justification of at least ${String(MIN_JUSTIFICATION)} characters is required`,
        {
          details: [{ field: "justification", message: `≥ ${String(MIN_JUSTIFICATION)} characters` }],
        },
      );
    }
    if (input.finalSeverity === undefined && input.sensitivity === undefined) {
      throw new DomainError("VALIDATION_ERROR", "request failed validation", {
        details: [{ field: "body", message: "finalSeverity and/or sensitivity is required" }],
      });
    }

    for (let attempt = 1; ; attempt++) {
      const current = await this.deps.archive.find("standard", access.tenantId, input.eventId);
      if (current === null) throw new DomainError("EVENT_NOT_FOUND", "event not found");
      const before = {
        sensitivity: current.classification.sensitivity,
        final_severity: current.classification.final_severity,
      };
      const after = {
        sensitivity: input.sensitivity ?? before.sensitivity,
        final_severity: input.finalSeverity ?? before.final_severity,
      };
      const last = current.classificationHistory[current.classificationHistory.length - 1];
      if (
        current.status === "OVERRIDDEN" &&
        before.sensitivity === after.sensitivity &&
        before.final_severity === after.final_severity &&
        last?.actor === `user:${actorId}` &&
        last.justification === justification
      ) {
        return { ...current, tier: "standard" }; // the same override again: nothing to do
      }

      const at = this.now();
      const next: ArchivedEvent = {
        ...current,
        classification: {
          ...current.classification,
          sensitivity: after.sensitivity,
          final_severity: after.final_severity,
          classification_source: "ANALYST",
          revision: current.classification.revision + 1,
        },
        status: "OVERRIDDEN",
        statusHistory: [...current.statusHistory, { status: "OVERRIDDEN", at, by: `user:${actorId}` }],
        classificationHistory: [
          ...current.classificationHistory,
          {
            stage: "ANALYST",
            source: "ANALYST",
            sensitivity: after.sensitivity,
            severity: after.final_severity,
            confidence: null,
            version: OVERRIDE_VERSION,
            at,
            actor: `user:${actorId}`,
            justification,
          },
        ],
        pendingAiScan: false,
      };
      const restricted = after.sensitivity === "RESTRICTED";
      if (restricted) next.expireAt = expireAt(next.archivedAt, "restricted", 0);

      const applied = await this.deps.client.withSession((session) =>
        session.withTransaction(async () => {
          const ok = restricted
            ? await this.deps.archive.moveToRestricted(session, current.classification.revision, next)
            : await this.deps.archive.replaceIfRevision(session, "standard", current.classification.revision, next);
          if (!ok) return false;
          await this.deps.outbox.enqueue(
            session,
            classificationOverridden(this.deps.version, next, { before, after, actorId, justification }),
            at,
          );
          return true;
        }),
      );
      if (applied) {
        this.deps.logger.info(
          { tenantId: access.tenantId, eventId: input.eventId, before, after, actor: access.actor, moved: restricted },
          "event.classification.overridden",
        );
        return { ...next, tier: restricted ? "restricted" : "standard" };
      }
      if (attempt >= MAX_ATTEMPTS) throw new DomainError("CONFLICT", "the classification changed concurrently; retry");
    }
  }
}
