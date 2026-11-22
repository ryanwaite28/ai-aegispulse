// Typed view of topology/aegispulse.topology.json plus invariant checks (ADR-0003).
import { join } from "node:path";
import { contractsRoot, readJson } from "./schemas.js";

export interface Exchange {
  name: string;
  type: "topic" | "direct" | "fanout";
  durable: boolean;
  description?: string;
}
export interface Queue {
  name: string;
  owner: string;
  type: "quorum" | "classic";
  durable: boolean;
  prefetch?: number;
  retryTiers?: Array<"1s" | "5s" | "30s">;
  deadLetterQueue?: string | null;
  role?: "retry" | "dlq" | "delay";
  arguments: Record<string, string | number | boolean>;
  fr?: string[];
}
export interface Binding {
  exchange: string;
  queue: string;
  routingKey: string;
}
export interface Topology {
  version: string;
  exchanges: Exchange[];
  queues: Queue[];
  bindings: Binding[];
}

export function loadTopology(): Topology {
  return readJson(join(contractsRoot, "topology", "aegispulse.topology.json")) as Topology;
}

/** Returns a list of invariant violations; empty means the topology is internally consistent. */
export function topologyViolations(t: Topology): string[] {
  const errors: string[] = [];
  const exchanges = new Set(t.exchanges.map((e) => e.name));
  const queues = new Map(t.queues.map((q) => [q.name, q]));
  if (queues.size !== t.queues.length) errors.push("duplicate queue names");
  for (const b of t.bindings) {
    if (!exchanges.has(b.exchange)) errors.push(`binding to unknown exchange ${b.exchange}`);
    if (!queues.has(b.queue)) errors.push(`binding of unknown queue ${b.queue}`);
  }
  for (const q of t.queues) {
    if (q.role !== undefined) continue;
    if (q.type !== "quorum") errors.push(`${q.name}: work queues must be quorum`);
    if (q.prefetch === undefined) errors.push(`${q.name}: prefetch required`);
    for (const tier of q.retryTiers ?? []) {
      const rq = queues.get(`${q.name}.retry.${tier}`);
      if (rq === undefined) errors.push(`${q.name}: missing retry queue for ${tier}`);
      else if (rq.arguments["x-dead-letter-routing-key"] !== q.name)
        errors.push(`${rq.name}: must dead-letter back to ${q.name}`);
    }
    if (q.deadLetterQueue != null) {
      if (!queues.has(q.deadLetterQueue)) errors.push(`${q.name}: missing DLQ ${q.deadLetterQueue}`);
      const bound = t.bindings.some(
        (b) => b.exchange === "aegispulse.dlx" && b.queue === q.deadLetterQueue && b.routingKey === q.name,
      );
      if (!bound) errors.push(`${q.name}: DLQ not bound on aegispulse.dlx with key ${q.name}`);
    }
  }
  return errors;
}

/** Concrete (wildcard-free) routing keys bound on the four domain exchanges. */
export function concreteRoutingKeys(t: Topology): string[] {
  const domain = new Set([
    "aegispulse.ingress",
    "aegispulse.enrichment",
    "aegispulse.domain",
    "aegispulse.intelligence",
  ]);
  return [
    ...new Set(t.bindings.filter((b) => domain.has(b.exchange) && !/[#*]/.test(b.routingKey)).map((b) => b.routingKey)),
  ].sort();
}
