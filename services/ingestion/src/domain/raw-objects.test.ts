import { describe, expect, it } from "vitest";
import { isSweepCandidate, rawWebhookKey, sweepPrefixes } from "./raw-objects.js";

const T = "8a92269a-91aa-4d80-b6fd-093a350304fe";
const O = "0b6f3c1e-2f4a-4c55-9d2e-6a7b8c9d0e1f";
const now = new Date("2026-11-24T12:00:00Z");

describe("raw webhook objects (FR-WHK-05/08)", () => {
  it("builds the §7.8 key and the UTC day prefixes a sweep lists", () => {
    expect(rawWebhookKey(T, new Date("2026-11-24T00:30:00Z"), O)).toBe(`raw/webhooks/${T}/2026/11/24/${O}.json`);
    expect(sweepPrefixes(T, now, 3)).toEqual([
      `raw/webhooks/${T}/2026/11/24/`,
      `raw/webhooks/${T}/2026/11/23/`,
      `raw/webhooks/${T}/2026/11/22/`,
    ]);
    expect(sweepPrefixes(T, new Date("2026-03-01T01:00:00Z"), 2)[1]).toBe(`raw/webhooks/${T}/2026/02/28/`);
  });

  it("FR-WHK-08 only objects older than 1 h with the service's own key shape are candidates", () => {
    const key = rawWebhookKey(T, now, O);
    expect(isSweepCandidate(key, new Date(now.getTime() - 3_601_000), now)).toBe(true);
    expect(isSweepCandidate(key, new Date(now.getTime() - 3_599_000), now)).toBe(false);
    expect(isSweepCandidate(`raw/webhooks/${T}/2026/11/24/notes.txt`, new Date(0), now)).toBe(false);
    expect(isSweepCandidate("raw/webhooks/.readiness", new Date(0), now)).toBe(false);
  });
});
