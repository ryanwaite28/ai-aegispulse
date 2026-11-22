import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contractsRoot, createAjv, ENVELOPE_ID, readJson } from "../src/schemas.js";

const examples = (kind: "valid" | "invalid"): string[] =>
  readdirSync(join(contractsRoot, "envelope", "examples", kind)).filter((f) => f.endsWith(".json"));

describe("canonical envelope v1 (PROJECT.md §6.4)", () => {
  const ajv = createAjv();
  const validate = ajv.getSchema(ENVELOPE_ID);

  it("compiles under strict Ajv 2020", () => {
    expect(validate).toBeDefined();
  });

  it.each(examples("valid"))("accepts valid example %s", (file) => {
    const ok = validate?.(readJson(join(contractsRoot, "envelope", "examples", "valid", file)));
    expect(validate?.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it.each(examples("invalid"))("rejects invalid example %s (poison → DLQ ENVELOPE_INVALID)", (file) => {
    expect(validate?.(readJson(join(contractsRoot, "envelope", "examples", "invalid", file)))).toBe(false);
  });
});
