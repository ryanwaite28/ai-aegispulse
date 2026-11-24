// files.validation.q consumer adapter (FR-FILE-05): parse the file.uploaded envelope → one service action → the kit
// acks, retries (1 s/5 s/30 s) or dead-letters. No business logic here.
import type { AegisAmqpClient } from "@aegispulse/ts-platform/amqp";
import { consumeEnvelopes } from "@aegispulse/ts-platform/amqp";
import { PoisonMessageError } from "@aegispulse/ts-platform/errors";
import type { Logger } from "@aegispulse/ts-platform/logging";
import type { FileValidationService } from "../../service/file-validation.service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function consumeFileValidation(
  client: AegisAmqpClient,
  logger: Logger,
  service: FileValidationService,
): ReturnType<typeof consumeEnvelopes> {
  return consumeEnvelopes({
    client,
    queue: "files.validation.q",
    logger,
    handler: async (envelope, context) => {
      const payload = envelope.payload as { fileId?: unknown; storageKey?: unknown };
      if (
        envelope.eventType !== "file.uploaded" ||
        envelope.tenantId === null ||
        typeof payload.fileId !== "string" ||
        !UUID.test(payload.fileId) ||
        typeof payload.storageKey !== "string"
      ) {
        throw new PoisonMessageError("VALIDATION_ERROR", "not a file.uploaded envelope");
      }
      return service.validateFile({
        eventId: envelope.eventId,
        replayGeneration: context.replayGeneration,
        tenantId: envelope.tenantId,
        fileId: payload.fileId,
        storageKey: payload.storageKey,
      });
    },
  });
}
