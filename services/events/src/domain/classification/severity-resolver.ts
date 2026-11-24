// Final severity resolution (PROJECT.md §1.4.3, `severity-resolver-v1`, ADR-0008). Pure; elevate-only for every
// automated stage. Only an analyst override (with justification, FR-CLS-07) may produce a lower value.
import { maxSeverity, type Severity } from "./severity.js";

export const RESOLVER_VERSION = "severity-resolver-v1";
/** Stage 2 results count only at or above this confidence. */
export const AI_MIN_CONFIDENCE = 0.6;

export interface ResolutionInput {
  /** Stage 1 result (always present). */
  readonly rule: Severity;
  /** Stage 2 result, when scanned. */
  readonly ai?: { readonly severity: Severity; readonly confidence: number } | undefined;
  /** publisher_stated_severity (verbatim; may be null). */
  readonly publisher: Severity | null;
  /** classification.source_trust_level === "TRUSTED" (stamped by the producer at ingest). */
  readonly trustedSource: boolean;
  /** An analyst override wins outright (OVERRIDDEN). */
  readonly override?: Severity | undefined;
}

export interface Resolution {
  readonly algorithm: Severity;
  readonly final: Severity;
  readonly source: "RULES" | "AI_SCANNER" | "ANALYST";
}

export function resolveSeverity(i: ResolutionInput): Resolution {
  const aiCounts = i.ai !== undefined && i.ai.confidence >= AI_MIN_CONFIDENCE;
  const algorithm = aiCounts && i.ai !== undefined ? maxSeverity(i.rule, i.ai.severity) : i.rule;
  const source = aiCounts ? "AI_SCANNER" : "RULES";
  if (i.override !== undefined) return { algorithm, final: i.override, source: "ANALYST" };
  const final = i.trustedSource && i.publisher !== null ? maxSeverity(algorithm, i.publisher) : algorithm;
  return { algorithm, final, source };
}
