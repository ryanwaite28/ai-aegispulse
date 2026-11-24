import { describe, expect, it } from "vitest";
import { loadTopology, topologyViolations } from "../src/topology.js";

describe("RabbitMQ topology contract (PROJECT.md §5.5, ADR-0003)", () => {
  const t = loadTopology();

  it("is internally consistent (bindings, retry tiers, DLQs)", () => {
    expect(topologyViolations(t)).toEqual([]);
  });

  it("binds events.archive.q with # on all four domain exchanges (FR-EVT-01)", () => {
    const keys = t.bindings.filter((b) => b.queue === "events.archive.q").map((b) => `${b.exchange}:${b.routingKey}`);
    expect(keys.sort()).toEqual(
      ["aegispulse.domain:#", "aegispulse.enrichment:#", "aegispulse.ingress:#", "aegispulse.intelligence:#"].sort(),
    );
  });

  it("captures every dead letter in the registry via the topic dlx (FR-MSG-02)", () => {
    expect(t.exchanges.find((e) => e.name === "aegispulse.dlx")?.type).toBe("topic");
    expect(t.bindings).toContainEqual({ exchange: "aegispulse.dlx", queue: "events.deadletter.q", routingKey: "#" });
  });

  it("uses 1s/5s/30s retry tiers with TTL dead-lettering back to the source queue (FR-MSG-01)", () => {
    const rq = t.queues.find((q) => q.name === "orchestrator.txn.q.retry.5s");
    expect(rq?.arguments).toMatchObject({
      "x-message-ttl": 5000,
      "x-dead-letter-exchange": "",
      "x-dead-letter-routing-key": "orchestrator.txn.q",
    });
  });

  it("makes every work queue a quorum queue with a delivery-limit backstop", () => {
    for (const q of t.queues.filter((x) => x.role === undefined)) {
      expect(q.arguments, q.name).toMatchObject({ "x-queue-type": "quorum", "x-delivery-limit": 10 });
    }
  });

  it("detects a missing DLQ binding", () => {
    const broken = { ...t, bindings: t.bindings.filter((b) => b.queue !== "files.validation.q.dlq") };
    expect(topologyViolations(broken)).toContain(
      "files.validation.q: DLQ not bound on aegispulse.dlx with key files.validation.q",
    );
  });
});
