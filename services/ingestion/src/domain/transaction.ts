// Transaction intake rules (FR-TXN-01). Pure: the shape is validated by the route (contract SubmitTransactionInput);
// these are the rules that need the clock, the FX table or canonical hashing.
import { createHash } from "node:crypto";

export type Channel = "WIRE" | "ACH" | "CARD" | "CRYPTO" | "INTERNAL";

export interface TransactionInput {
  readonly idempotencyKey: string;
  readonly accountId: string;
  readonly counterpartyId: string;
  readonly counterpartyName: string;
  /** Decimal string, > 0, ≤ 18 integer digits, 2–4 decimals (checked by the route pattern). */
  readonly amount: string;
  readonly currency: string;
  readonly country: string;
  readonly channel: Channel;
  readonly occurredAt: string;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

/** occurredAt more than this far in the future is rejected. */
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
export const MAX_METADATA_BYTES = 4096;

export interface RuleViolation {
  readonly field: string;
  readonly message: string;
}

/** FR-TXN-01 rules beyond the shape: FX currency, future skew, metadata size. Empty = valid. */
export function intakeViolations(input: TransactionInput, now: Date, currencies: ReadonlySet<string>): RuleViolation[] {
  const out: RuleViolation[] = [];
  if (!currencies.has(input.currency)) {
    out.push({ field: "currency", message: "not in the static FX table (fx-static-v1)" });
  }
  const at = Date.parse(input.occurredAt);
  if (Number.isNaN(at)) out.push({ field: "occurredAt", message: "not a date-time" });
  else if (at - now.getTime() > MAX_FUTURE_SKEW_MS) {
    out.push({ field: "occurredAt", message: "more than 24 h in the future" });
  }
  if (Buffer.byteLength(JSON.stringify(input.metadata ?? {}), "utf8") > MAX_METADATA_BYTES) {
    out.push({ field: "metadata", message: "larger than 4 KiB" });
  }
  return out;
}

/** JSON with object keys sorted at every level (stable hashing; arrays keep their order). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** request_sha256: the canonical request body; key reuse with a different body → IDEMPOTENCY_KEY_REUSED. */
export function requestHash(input: TransactionInput): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}
