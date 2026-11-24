// Severity and sensitivity scales (PROJECT.md §1.4.1). Pure.

export const SEVERITIES = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** UNCLASSIFIED ranks lowest: "not yet determined" is raised by any rule that applies. */
export const SENSITIVITIES = ["UNCLASSIFIED", "PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export type Category = "PII" | "MNPI" | "REGULATORY" | "FINANCIAL" | "SECRET";

export function isSeverity(v: unknown): v is Severity {
  return typeof v === "string" && (SEVERITIES as readonly string[]).includes(v);
}

export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITIES.indexOf(a) >= SEVERITIES.indexOf(b) ? a : b;
}

export function severityAtLeast(a: Severity, floor: Severity): boolean {
  return SEVERITIES.indexOf(a) >= SEVERITIES.indexOf(floor);
}

export function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return SENSITIVITIES.indexOf(a) >= SENSITIVITIES.indexOf(b) ? a : b;
}
