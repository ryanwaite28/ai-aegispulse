// orchestrator.txn.q consumer adapter (FR-TXN-03): the kit validates the envelope, then this runs the one saga; the
// kit acks, retries (1 s/5 s/30 s) or dead-letters. No logic here.
import type { AegisAmqpClient } from "@aegispulse/ts-platform/amqp";
import { consumeEnvelopes } from "@aegispulse/ts-platform/amqp";
import type { Logger } from "@aegispulse/ts-platform/logging";
import type { ScoreTransactionSaga } from "../../service/orchestrators/score-transaction.saga.js";

export function consumeTransactions(
  client: AegisAmqpClient,
  logger: Logger,
  saga: ScoreTransactionSaga,
): ReturnType<typeof consumeEnvelopes> {
  return consumeEnvelopes({
    client,
    queue: "orchestrator.txn.q",
    logger,
    handler: async (envelope) => {
      await saga.run(envelope);
      return "processed";
    },
  });
}
