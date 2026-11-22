// Loads contract JSON Schemas into a single strict Ajv 2020 instance (shared by validate.ts and tests).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";

export const contractsRoot: string = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ENVELOPE_ID = "https://aegispulse.dev/contracts/envelope/canonical-envelope.v1.schema.json";

type AddFormats = (ajv: Ajv2020) => Ajv2020;
const addFormats = addFormatsImport as unknown as AddFormats;

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function eventSchemaFiles(): string[] {
  const dir = join(contractsRoot, "events");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".v1.schema.json"))
    .sort();
}

export function routingKeyOf(file: string): string {
  return file.replace(/\.v1\.schema\.json$/, "");
}

export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  ajv.addSchema(readJson(join(contractsRoot, "envelope", "canonical-envelope.v1.schema.json")) as object);
  for (const f of eventSchemaFiles()) {
    ajv.addSchema(readJson(join(contractsRoot, "events", f)) as object);
  }
  return ajv;
}
