// events.deadletter.q consumer adapter (FR-MSG-02): raw consumption (dead letters may be poison, so no envelope
// validation), one service action, ack; on failure the kit waits 5 s and requeues (this queue has no DLQ, §5.5).
import type { AegisAmqpClient } from "@aegispulse/ts-platform/amqp";
import { consumeRaw } from "@aegispulse/ts-platform/amqp";
import type { Logger } from "@aegispulse/ts-platform/logging";
import type { DeadLetterService } from "../../service/dead-letter.service.js";

export function consumeDeadLetters(
  client: AegisAmqpClient,
  logger: Logger,
  service: DeadLetterService,
): ReturnType<typeof consumeRaw> {
  return consumeRaw({
    client,
    queue: "events.deadletter.q",
    logger,
    handler: async (delivery) => {
      await service.recordDeadLetter({
        content: delivery.content,
        headers: delivery.headers,
        messageId: delivery.messageId,
        routingKey: delivery.routingKey,
      });
    },
  });
}
