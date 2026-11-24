// Allowed roles per public operation, read once from the generated contract table (x-aegis-roles). The gateway
// enforces the same table; events re-checks it (defense in depth, FR-AUTH-06) so the two can never drift.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GatewayOperationId, GatewayRoute } from "@aegispulse/contracts/generated/ts/gateway-routes.ts";

const ROUTES = JSON.parse(
  readFileSync(fileURLToPath(import.meta.resolve("@aegispulse/contracts/gateway-routes")), "utf8"),
) as Record<GatewayOperationId, GatewayRoute>;

export function rolesFor(operationId: GatewayOperationId): readonly string[] {
  return ROUTES[operationId].roles;
}
