// Asserts the RabbitMQ topology idempotently (PROJECT.md §6.5). Run with the aegis_topology user.
// Usage: AMQP_URL=amqp://aegis_topology:...@host:5672/vhost tsx scripts/topology-assert.ts [--check]
// --check: passive verification only (fails if anything is missing; never creates).
import amqp from "amqplib";
import { loadTopology, topologyViolations } from "../src/topology.js";

export async function assertTopology(
  url: string,
  checkOnly: boolean,
): Promise<{ exchanges: number; queues: number; bindings: number }> {
  const topology = loadTopology();
  const violations = topologyViolations(topology);
  if (violations.length > 0) throw new Error(`topology contract invalid:\n  ${violations.join("\n  ")}`);
  const conn = await amqp.connect(url);
  try {
    let ch = await conn.createChannel();
    for (const ex of topology.exchanges) {
      if (checkOnly) await ch.checkExchange(ex.name);
      else await ch.assertExchange(ex.name, ex.type, { durable: ex.durable });
    }
    for (const q of topology.queues) {
      if (checkOnly) await ch.checkQueue(q.name);
      else await ch.assertQueue(q.name, { durable: q.durable, arguments: q.arguments });
    }
    if (!checkOnly) {
      for (const b of topology.bindings) await ch.bindQueue(b.queue, b.exchange, b.routingKey);
    }
    await ch.close();
    ch = await conn.createChannel();
    await ch.close();
    return { exchanges: topology.exchanges.length, queues: topology.queues.length, bindings: topology.bindings.length };
  } finally {
    await conn.close();
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const url = process.env["AMQP_URL"];
  if (url === undefined || url === "") {
    process.stderr.write("topology-assert: AMQP_URL is required\n");
    process.exit(2);
  }
  const checkOnly = process.argv.includes("--check");
  assertTopology(url, checkOnly)
    .then((r) =>
      process.stdout.write(
        `topology-assert: ${checkOnly ? "verified" : "asserted"} ${r.exchanges} exchanges, ${r.queues} queues, ${r.bindings} bindings\n`,
      ),
    )
    .catch((e: unknown) => {
      process.stderr.write(`topology-assert: FAILED ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    });
}
