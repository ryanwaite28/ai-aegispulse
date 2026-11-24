import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { PLATFORM_TENANT_ID } from "@aegispulse/ts-platform/auth";
import { createLogger } from "@aegispulse/ts-platform/logging";
import { RegistryTenantRetention } from "./tenant-retention.js";

const logger = createLogger({
  service: "events",
  version: "t",
  env: "local",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const T = "8f2a6a5e-3d1b-4c7e-9a0f-1b2c3d4e5f60";

describe("tenant retention lookup (FR-EVT-03; found on the stack: platform-tenant events were dead-lettered)", () => {
  it("uses the registry value; platform tenant, tenantless and unknown tenants get 400; other errors propagate", async () => {
    const calls: string[] = [];
    const settings = {
      get: (id: string) => {
        calls.push(id);
        if (id === T) return Promise.resolve({ retentionDays: 30 } as never);
        if (id === "boom") return Promise.reject(Object.assign(new Error("down"), { code: "DEPENDENCY_UNAVAILABLE" }));
        return Promise.reject(Object.assign(new Error("tenant not found"), { code: "NOT_FOUND" }));
      },
    };
    const r = new RegistryTenantRetention(settings, logger);
    expect(await r.retentionDays(T)).toBe(30);
    expect(await r.retentionDays(PLATFORM_TENANT_ID)).toBe(400);
    expect(await r.retentionDays(null)).toBe(400);
    expect(await r.retentionDays("11111111-1111-4111-8111-111111111111")).toBe(400);
    await expect(r.retentionDays("boom")).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    expect(calls).not.toContain(PLATFORM_TENANT_ID); // never asks the registry for the platform tenant
  });
});
