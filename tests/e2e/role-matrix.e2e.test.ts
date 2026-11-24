// FR-AUTH-06 generated table test: every Phase-2 registry route × every role, through the gateway. Routes and roles
// come from the generated contract table (gateway.public.yaml). Allowed roles must get past authorization (no
// 401/403, and no 5xx; bodies are deliberately incomplete so nothing is mutated → 422/404). Denied roles get 403.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { call, ROLES, world, type RoleName } from "./support/world.js";

interface Route {
  method: string;
  path: string;
  roles: string[];
  backing: string[];
}
const routes = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../packages/contracts/generated/gateway-routes.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, Route>;

// Routes implemented so far, by phase (the matrix grows as phases land; roles always come from the contract).
const IMPLEMENTED: Record<string, readonly string[]> = {
  "Phase 2": [
    "changePassword",
    "createServiceAccount",
    "createTenant",
    "createUser",
    "getCurrentPrincipal",
    "getTenant",
    "listServiceAccounts",
    "listUsers",
    "logout",
    "revokeServiceAccount",
    "rotateServiceAccountSecret",
    "updateTenant",
    "updateUser",
  ],
  "Phase 3": [
    "listEntities",
    "createEntity",
    "getEntity",
    "updateEntity",
    "archiveEntity",
    "listWatchlists",
    "createWatchlist",
    "updateWatchlist",
    "deleteWatchlist",
    "addWatchlistEntry",
    "removeWatchlistEntry",
  ],
  "Phase 4": [
    "listWebhookSources",
    "createWebhookSource",
    "updateWebhookSource",
    "rotateWebhookSecret",
    "deleteWebhookSource",
    "listWebhookDeliveries",
  ],
  "Phase 5": [
    "initUpload",
    "completeUpload",
    "abortUpload",
    "listFiles",
    "getFile",
    "getFileDownloadUrl",
    "deleteFile",
  ],
  "Phase 6": ["searchEvents", "getEvent", "getEventCorrelationChain", "overrideEventClassification"],
  "Phase 7": ["listDeadLetters", "getDeadLetter", "replayDeadLetter", "discardDeadLetter"],
};
const implemented = new Set(Object.values(IMPLEMENTED).flat());
const phase2 = Object.entries(routes).filter(([id]) => implemented.has(id));
const RANDOM_ID = "00000000-0000-4000-8000-000000000000";

describe("FR-AUTH-06 role matrix over the gateway", () => {
  it("every implemented route is in the contract with a non-empty role list", () => {
    expect(phase2.map(([id]) => id).sort()).toEqual([...implemented].sort());
    for (const [, r] of phase2) expect(r.roles.length).toBeGreaterThan(0);
  });

  for (const [id, route] of phase2) {
    for (const role of ROLES) {
      const allowed = route.roles.includes(role);
      it(`${id} (${route.method} ${route.path}) × ${role} → ${allowed ? "allowed" : "403"}`, async () => {
        const w = await world();
        const path = route.path
          .replace("{tenantId}", w.a.id)
          .replace("{userId}", RANDOM_ID)
          .replace("{id}", RANDOM_ID)
          .replace("{fileId}", RANDOM_ID)
          .replace("{eventId}", RANDOM_ID)
          .replace("{correlationId}", "corr-e2e-none");
        const body = route.method === "GET" || route.method === "DELETE" ? undefined : {};
        const headers: Record<string, string> =
          role === ("PLATFORM_ADMIN" satisfies RoleName) ? { "x-aegis-tenant": w.a.id } : {};
        const r = await call(route.method, path, {
          token: w.token(role),
          headers,
          ...(body === undefined ? {} : { body }),
        });
        if (allowed) {
          expect([401, 403], `${id} × ${role}: ${JSON.stringify(r.body.error)}`).not.toContain(r.status);
          // Authorized calls must reach a healthy owning service: a 5xx (e.g. 503 dependency down) is a failure.
          expect(r.status, `${id} × ${role}: ${JSON.stringify(r.body.error)}`).toBeLessThan(500);
        } else {
          expect(r.status, `${id} × ${role}`).toBe(403);
        }
      });
    }
  }
});
