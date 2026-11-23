// GET /v1/openapi.json — the bundled public OpenAPI document from packages/contracts (§8.3; used by ZAP API scans).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Controller, Get, Header } from "@nestjs/common";
import { parse } from "yaml";
import { Public } from "../../common/guards/jwt-auth.guard.js";

let cached: unknown;

export function publicOpenApi(): unknown {
  cached ??= parse(
    readFileSync(fileURLToPath(import.meta.resolve("@aegispulse/contracts/openapi/gateway.public.yaml")), "utf8"),
  ) as unknown;
  return cached;
}

@Public()
@Controller("v1")
export class OpenApiController {
  @Get("openapi.json")
  @Header("cache-control", "public, max-age=300")
  document(): unknown {
    return publicOpenApi();
  }
}
