import { describe, expect, it } from "vitest";
import { expireAt } from "./retention.js";

describe("archive retention (FR-EVT-03/07)", () => {
  it("standard tier: archivedAt + tenant retentionDays; restricted: + 7 years (calendar, UTC)", () => {
    const at = new Date("2026-11-24T12:00:00Z");
    expect(expireAt(at, "standard", 400).toISOString()).toBe("2027-12-29T12:00:00.000Z");
    expect(expireAt(at, "standard", 30).toISOString()).toBe("2026-12-24T12:00:00.000Z");
    expect(expireAt(at, "restricted", 30).toISOString()).toBe("2033-11-24T12:00:00.000Z");
  });
});
