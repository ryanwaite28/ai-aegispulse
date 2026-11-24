// events.archive.q consumer adapter (FR-EVT-01): the kit validates the envelope (invalid → DLQ ENVELOPE_INVALID, no
// retry), then this calls the one service action and the kit acks / retries / dead-letters. No logic here.
import type { AegisAmqpClient } from "@aegispulse/ts-platform/amqp";
import { consumeEnvelopes } from "@aegispulse/ts-platform/amqp";
import type { Logger } from "@aegispulse/ts-platform/logging";
import type { ArchiveService } from "../../service/archive.service.js";

export function consumeArchive(
  client: AegisAmqpClient,
  logger: Logger,
  service: ArchiveService,
): ReturnType<typeof consumeEnvelopes> {
  return consumeEnvelopes({
    client,
    queue: "events.archive.q",
    logger,
    handler: async (envelope, context) => {
      const outcome = await service.archiveEvent(envelope, {
        exchange: context.exchange,
        routingKey: context.routingKey,
        replayJob: context.replayJob,
      });
      return outcome === "duplicate" ? "duplicate" : "processed";
    },
  });
}
