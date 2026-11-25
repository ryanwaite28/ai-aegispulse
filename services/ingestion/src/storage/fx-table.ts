// The static FX table contract (packages/contracts/reference/fx-static-v1.json, §1.4.4): ingestion needs only the set
// of accepted currencies (FR-TXN-01). Read once from the contracts package, like the topology.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let currencies: ReadonlySet<string> | undefined;

export function fxCurrencies(): ReadonlySet<string> {
  if (currencies === undefined) {
    const path = fileURLToPath(import.meta.resolve("@aegispulse/contracts/reference/fx-static-v1"));
    const table = JSON.parse(readFileSync(path, "utf8")) as { usdPerUnit: Record<string, string> };
    currencies = new Set(Object.keys(table.usdPerUnit));
  }
  return currencies;
}
