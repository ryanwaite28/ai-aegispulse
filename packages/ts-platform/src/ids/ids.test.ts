import { describe, expect, it } from "vitest";
import { uuidv7 } from "./index.js";

describe("uuidv7 (RFC 9562, §6.4 eventId)", () => {
  it("encodes the millisecond timestamp, version 7 and variant 10", () => {
    const at = Date.parse("2026-11-24T12:00:00.123Z");
    const id = uuidv7(at);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBe(at);
  });

  it("orders across milliseconds and is unique within one", () => {
    expect(uuidv7(1000) < uuidv7(1001)).toBe(true);
    const many = new Set(Array.from({ length: 1000 }, () => uuidv7(5)));
    expect(many.size).toBe(1000);
  });
});
