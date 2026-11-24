import { describe, expect, it } from "vitest";
import { causalOrder } from "./correlation.js";

const ev = (
  eventId: string,
  causationId: string | null,
  t: number,
): { eventId: string; causationId: string | null; occurredAt: Date } => ({
  eventId,
  causationId,
  occurredAt: new Date(Date.UTC(2026, 10, 24, 12, 0, t)),
});

describe("correlation chain ordering (FR-EVT-05)", () => {
  it("puts every cause before its effects, depth-first, siblings by time", () => {
    // webhook a → classification b (+ scan c) → case d caused by b; e unrelated root later
    const chain = causalOrder([ev("d", "b", 5), ev("c", "a", 2), ev("b", "a", 3), ev("a", null, 1), ev("e", null, 4)]);
    expect(chain.map((e) => e.eventId)).toEqual(["a", "c", "b", "d", "e"]);
  });

  it("treats an event whose cause is outside the correlation as a root, survives cycles and keeps ties deterministic", () => {
    expect(causalOrder([ev("x", "missing", 2), ev("y", null, 1)]).map((e) => e.eventId)).toEqual(["y", "x"]);
    expect(
      causalOrder([ev("p", "q", 1), ev("q", "p", 2)])
        .map((e) => e.eventId)
        .sort(),
    ).toEqual(["p", "q"]);
    expect(causalOrder([ev("b", null, 1), ev("a", null, 1)]).map((e) => e.eventId)).toEqual(["a", "b"]);
  });
});
