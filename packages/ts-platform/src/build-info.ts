// Build identity for logs/traces (`{runtime}@{git sha}`, §6.4 producer). Images write /app/build-info.json at build
// time; local runs fall back to "dev". Not an env var, so §10.4 stays the single list of configuration.
import { existsSync, readFileSync } from "node:fs";

export function buildVersion(path = "/app/build-info.json"): string {
  if (!existsSync(path)) return "dev";
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { gitSha?: unknown };
  return typeof parsed.gitSha === "string" && /^[0-9a-f]{7,40}$/.test(parsed.gitSha) ? parsed.gitSha : "dev";
}
