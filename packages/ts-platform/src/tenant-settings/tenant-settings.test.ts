import { describe, expect, it } from "vitest";
import { TenantSettingsCache, type TenantSettings } from "./index.js";

const settings = (n: number): TenantSettings =>
  ({ id: "t-1", highValueThresholdUsd: String(n) }) as unknown as TenantSettings;

describe("TenantSettingsCache (FR-TEN-08: callers cache ≤ 60 s)", () => {
  it("serves from cache inside the TTL, refetches after it, and shares concurrent misses", async () => {
    let clock = 0;
    let calls = 0;
    const cache = new TenantSettingsCache({
      fetch: () => Promise.resolve(settings(++calls)),
      now: () => clock,
    });
    const [a, b] = await Promise.all([cache.get("t-1"), cache.get("t-1")]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    clock = 59_999;
    expect((await cache.get("t-1")).highValueThresholdUsd).toBe("1");
    clock = 60_000;
    expect((await cache.get("t-1")).highValueThresholdUsd).toBe("2"); // change visible within 60 s
    cache.invalidate("t-1");
    expect((await cache.get("t-1")).highValueThresholdUsd).toBe("3");
  });

  it("never caches longer than 60 s and never caches failures", async () => {
    let clock = 0;
    let fail = true;
    const cache = new TenantSettingsCache({
      fetch: () => (fail ? Promise.reject(new Error("registry down")) : Promise.resolve(settings(7))),
      ttlMs: 10 * 60_000,
      now: () => clock,
    });
    await expect(cache.get("t-1")).rejects.toThrow("registry down");
    fail = false;
    await cache.get("t-1");
    fail = true;
    clock = 60_000;
    await expect(cache.get("t-1")).rejects.toThrow("registry down"); // TTL clamped to 60 s
  });
});
