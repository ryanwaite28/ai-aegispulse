import { describe, expect, it } from "vitest";
import { hasFailures } from "./trigger.js";

describe("JobRunSummary partial failure (sweep fault isolation)", () => {
  it("a run with failed items fails the CronJob; none or absent passes", () => {
    expect(hasFailures({ processedCount: 4, failedCount: 1 })).toBe(true);
    expect(hasFailures({ processedCount: 4, failedCount: 0 })).toBe(false);
    expect(hasFailures({ processedCount: 4 })).toBe(false); // services that do not report failedCount
  });
});
