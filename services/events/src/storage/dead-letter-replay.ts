// DeadLetterReplayPort over the contract topology (FR-MSG-03): a replay goes out on aegispulse.retry to the shortest
// retry/delay queue that dead-letters back into the original queue (e.g. files.validation.q.retry.1s), so events
// needs only its §5.7.3 aegispulse.retry write grant. Confirmed publish (the kit's confirm channel).
import { publishRaw, replayRoute, type AegisAmqpClient } from "@aegispulse/ts-platform/amqp";
import type { DeadLetterReplayPort } from "../service/dead-letter.service.js";

export class TopologyReplayPublisher implements DeadLetterReplayPort {
  constructor(private readonly client: AegisAmqpClient) {}

  canReplay(queue: string): boolean {
    return replayRoute(queue) !== undefined;
  }

  async republish(queue: string, message: Parameters<DeadLetterReplayPort["republish"]>[1]): Promise<void> {
    const route = replayRoute(queue);
    if (route === undefined) throw new Error(`no replay route into ${queue}`);
    await publishRaw(this.client, {
      exchange: route.exchange,
      routingKey: route.routingKey,
      body: message.body,
      headers: message.headers,
      messageId: message.messageId,
      correlationId: message.correlationId,
      type: message.type,
    });
  }
}
