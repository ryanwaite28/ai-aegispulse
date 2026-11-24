// Scheduled maintenance action (§6.2 ingestion.expirePreviousSecrets, FR-WHK-08). Caller: scheduler-trigger only
// (SERVICE token with act ingestion.expirePreviousSecrets). Parse → one service call → map.
import type { JwtVerifier } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { HttpServer } from "@aegispulse/ts-platform/http";
import { getContext } from "@aegispulse/ts-platform/logging";
import { z } from "zod";
import type { WebhookMaintenanceService } from "../../service/webhook-maintenance.service.js";

const empty = z.object({}).strict();

export function registerMaintenanceRoutes(
  app: HttpServer,
  verifier: JwtVerifier,
  maintenance: WebhookMaintenanceService,
): void {
  app.post("/internal/v1/expirePreviousSecrets", async (req) => {
    const authorization = typeof req.headers["authorization"] === "string" ? req.headers["authorization"] : undefined;
    const principal = await verifier.authorizeInternal(authorization, "ingestion.expirePreviousSecrets");
    if (!empty.safeParse(req.body ?? {}).success) {
      throw new DomainError("VALIDATION_ERROR", "request failed validation", {
        details: [{ field: "body", message: "expected an empty object" }],
      });
    }
    const ctx = getContext();
    return {
      data: await maintenance.expirePreviousSecrets(principal),
      meta: {
        ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
        ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
      },
    };
  });
}
