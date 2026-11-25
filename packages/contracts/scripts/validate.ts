// `make contracts` step 1 (PROJECT.md §12 rule 13): validates every contract and their cross-references.
// Exits non-zero on the first category with errors; prints a summary line per check.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { contractsRoot, createAjv, ENVELOPE_ID, eventSchemaFiles, readJson, routingKeyOf } from "../src/schemas.js";
import { concreteRoutingKeys, loadTopology, topologyViolations } from "../src/topology.js";

const failures: string[] = [];
const report = (name: string, errors: string[], okDetail: string): void => {
  if (errors.length === 0) process.stdout.write(`✓ ${name}: ${okDetail}\n`);
  else {
    process.stdout.write(`✗ ${name}\n${errors.map((e) => `    ${e}`).join("\n")}\n`);
    failures.push(name);
  }
};

// 1. topology
const topology = loadTopology();
const tAjv = createAjv();
const tValidate = tAjv.compile(readJson(join(contractsRoot, "topology", "topology.schema.json")) as object);
const tErrors = tValidate(topology) ? [] : (tValidate.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ""}`);
tErrors.push(...topologyViolations(topology));
report(
  "topology",
  tErrors,
  `${topology.exchanges.length} exchanges, ${topology.queues.length} queues, ${topology.bindings.length} bindings`,
);

// 1b. reference data (static FX table, §1.4.4 / FR-TXN-01)
const fxAjv = createAjv();
const fxValidate = fxAjv.compile(readJson(join(contractsRoot, "reference", "fx-static.schema.json")) as object);
const fx = readJson(join(contractsRoot, "reference", "fx-static-v1.json")) as { version: string; usdPerUnit: object };
const fxErrors = fxValidate(fx) ? [] : (fxValidate.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ""}`);
if (fx.version !== "fx-static-v1") fxErrors.push(`fx-static-v1.json declares version ${fx.version}`);
report("reference", fxErrors, `${fx.version}: ${String(Object.keys(fx.usdPerUnit).length)} currencies`);

// 2. envelope + examples
const ajv = createAjv();
const envelope = ajv.getSchema(ENVELOPE_ID);
const envErrors: string[] = [];
if (envelope === undefined) envErrors.push("envelope schema failed to compile");
for (const kind of ["valid", "invalid"] as const) {
  for (const f of readdirSync(join(contractsRoot, "envelope", "examples", kind))) {
    const ok = envelope?.(readJson(join(contractsRoot, "envelope", "examples", kind, f))) === true;
    if (ok !== (kind === "valid")) envErrors.push(`${kind}/${f}: expected ${kind}`);
  }
}
report("envelope", envErrors, "schema compiles; valid/invalid examples behave");

// 3. event payload schemas + examples
const evErrors: string[] = [];
const eventKeys = eventSchemaFiles()
  .filter((f) => !f.startsWith("_"))
  .map(routingKeyOf);
for (const key of eventKeys) {
  const id = `https://aegispulse.dev/contracts/events/${key}.v1.schema.json`;
  const v = ajv.getSchema(id);
  if (v === undefined) {
    evErrors.push(`${key}: schema missing or $id mismatch (${id})`);
    continue;
  }
  const ex = join(contractsRoot, "events", "examples", `${key}.json`);
  if (!existsSync(ex)) evErrors.push(`${key}: example missing`);
  else if (v(readJson(ex)) !== true) evErrors.push(`${key}: example invalid ${JSON.stringify(v.errors)}`);
}
for (const key of concreteRoutingKeys(topology)) {
  if (!eventKeys.includes(key)) evErrors.push(`topology binds ${key} but no event schema exists`);
}
// A valid envelope example's payload must also satisfy its eventType's payload schema (found by java-platform, 1c).
for (const f of readdirSync(join(contractsRoot, "envelope", "examples", "valid"))) {
  const example = readJson(join(contractsRoot, "envelope", "examples", "valid", f)) as {
    eventType?: string;
    payload?: unknown;
  };
  const v = ajv.getSchema(`https://aegispulse.dev/contracts/events/${example.eventType ?? ""}.v1.schema.json`);
  if (v === undefined)
    evErrors.push(`envelope/examples/valid/${f}: no payload schema for eventType ${example.eventType ?? "(none)"}`);
  else if (v(example.payload) !== true)
    evErrors.push(`envelope/examples/valid/${f}: payload invalid for its eventType ${JSON.stringify(v.errors)}`);
}
report(
  "events",
  evErrors,
  `${eventKeys.length} payload schemas with valid examples; all topology keys covered; envelope example payloads conform`,
);

// 4. AsyncAPI ↔ events
const asyncPath = join(contractsRoot, "asyncapi", "aegispulse.asyncapi.yaml");
const aErrors: string[] = [];
if (!existsSync(asyncPath)) aErrors.push("asyncapi/aegispulse.asyncapi.yaml missing");
else {
  const doc = parseYaml(readFileSync(asyncPath, "utf8")) as { channels?: Record<string, { address?: string }> };
  const addresses = new Set(Object.values(doc.channels ?? {}).map((c) => c.address ?? ""));
  for (const key of eventKeys) if (!addresses.has(key)) aErrors.push(`event ${key} has no AsyncAPI channel`);
  for (const a of addresses)
    if (a !== "" && !/[#*]/.test(a) && !eventKeys.includes(a)) aErrors.push(`channel ${a} has no event schema`);
}
if (existsSync(asyncPath)) {
  const { Parser } = await import("@asyncapi/parser");
  const diagnostics = await new Parser().validate(readFileSync(asyncPath, "utf8"), { source: asyncPath });
  for (const d of diagnostics.filter((x) => x.severity === 0))
    aErrors.push(`asyncapi: ${d.message} at ${d.path.join(".")}`);
}
report("asyncapi", aErrors, "document valid; every event has a channel and vice versa");

// 5. OpenAPI lint + ServiceAction ↔ PROJECT.md §6.2
const oaDir = join(contractsRoot, "openapi");
const oErrors: string[] = [];
if (existsSync(join(oaDir, "redocly.yaml"))) {
  try {
    execFileSync("pnpm", ["exec", "redocly", "lint", "--config", "redocly.yaml", "--format", "summary"], {
      cwd: oaDir,
      stdio: "pipe",
    });
  } catch (e) {
    const out = (e as { stdout?: Buffer }).stdout?.toString() ?? String(e);
    oErrors.push(`redocly lint failed:\n${out.split("\n").slice(-15).join("\n")}`);
  }
} else oErrors.push("openapi/redocly.yaml missing");
const projectMd = readFileSync(join(contractsRoot, "..", "..", "PROJECT.md"), "utf8");
const section = projectMd.slice(
  projectMd.indexOf("### 6.2 Service Layer Internal RPC Contract"),
  projectMd.indexOf("### 6.3 Tech Stack"),
);
const specActions = new Set(
  [...section.matchAll(/service: '([a-zA-Z]+)';\s+action: '([a-zA-Z]+)'/g)].map((m) => `${m[1]}.${m[2]}`),
);
const contractActions = new Set<string>();
const fileToService: Record<string, string> = {
  "registry.internal.yaml": "registry",
  "ingestion.internal.yaml": "ingestion",
  "files.internal.yaml": "files",
  "events.internal.yaml": "events",
  "cases.internal.yaml": "cases",
  "risk-scoring.internal.yaml": "riskScoring",
  "sensitivity-scanner.internal.yaml": "scanner",
  "data-intel.internal.yaml": "dataIntel",
};
for (const [file, svc] of Object.entries(fileToService)) {
  const p = join(oaDir, file);
  if (!existsSync(p)) {
    oErrors.push(`${file} missing`);
    continue;
  }
  const doc = parseYaml(readFileSync(p, "utf8")) as {
    paths?: Record<string, Record<string, { operationId?: string }>>;
    "x-aegis-consumer-actions"?: string[];
  };
  for (const ops of Object.values(doc.paths ?? {}))
    for (const op of Object.values(ops)) if (op.operationId) contractActions.add(`${svc}.${op.operationId}`);
  for (const a of doc["x-aegis-consumer-actions"] ?? []) contractActions.add(`${svc}.${a}`);
}
// Services with only consumer-invoked actions have no OpenAPI file (orchestrator, docExtraction).
for (const a of specActions)
  if (a.startsWith("orchestrator.") || a.startsWith("docExtraction.")) contractActions.add(a);
for (const a of specActions) if (!contractActions.has(a)) oErrors.push(`§6.2 action ${a} has no contract operation`);
for (const a of contractActions)
  if (!specActions.has(a)) oErrors.push(`contract operation ${a} is not in PROJECT.md §6.2`);
report("openapi", oErrors, `redocly clean; ${specActions.size} §6.2 actions ↔ contract operations match`);

if (failures.length > 0) {
  process.stdout.write(`\ncontracts: ${failures.length} check(s) failed: ${failures.join(", ")}\n`);
  process.exit(1);
}
process.stdout.write("\ncontracts: all checks passed\n");
