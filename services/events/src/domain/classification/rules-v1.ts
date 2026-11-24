// Stage 1 rule classification `rules-v1.0.0` (PROJECT.md §1.4.2; FR-CLS-01). Pure and synchronous (p95 ≤ 5 ms):
//   1. baseline by event type → sensitivity, severity, whether Stage 2 is needed;
//   2. detectors over the payload (secrets, card numbers with Luhn, US SSNs, PII-named keys, MNPI lexicon), each
//      elevate-only; detected values are masked in the returned payload and listed in `redactions`.
// The caller hashes the payload *before* calling this (payloadSha256 is of the pre-redaction payload).
import { isSeverity, maxSensitivity, maxSeverity, type Category, type Sensitivity, type Severity } from "./severity.js";

export const RULE_VERSION = "rules-v1.0.0";

export interface Redaction {
  /** Dotted path into the payload, with [n] for array items (e.g. "payload.accounts[0].number"). */
  readonly path: string;
  readonly rule: string;
  readonly kind: "MASK";
}

export interface Stage1Result {
  readonly sensitivity: Sensitivity;
  readonly categories: readonly Category[];
  readonly severity: Severity;
  /** Stage 2 (AI scan) is required for this event (§1.4.2 last column). */
  readonly needsStage2: boolean;
  /** Event types whose classification never feeds back (no classification.* emitted; loop prevention). */
  readonly terminal: boolean;
  readonly payload: Record<string, unknown>;
  readonly redactions: readonly Redaction[];
}

interface Baseline {
  sensitivity: Sensitivity;
  severity: Severity;
  needsStage2: boolean;
  terminal: boolean;
}

/** Families that never trigger Stage 2 or classification events (prevents scan/finalize loops). */
const TERMINAL_PREFIXES = ["classification.", "intel.", "ops.", "registry.", "correlation.", "notification."];

const EXTERNAL: Readonly<Record<string, Severity>> = {
  "external.regulatory.published": "MEDIUM",
  "external.ipo.filed": "MEDIUM",
  "external.acquisition.announced": "HIGH",
  "external.market.alert": "MEDIUM",
  "external.compliance.disclosed": "HIGH",
};

/** doc.extraction.* severity from red flags (clarification of "from extraction red-flags"): 0 → LOW, 1–2 → MEDIUM, ≥ 3 → HIGH. */
function redFlagSeverity(payload: Record<string, unknown>): Severity {
  const flags = Array.isArray(payload["redFlags"]) ? payload["redFlags"].length : 0;
  return flags === 0 ? "LOW" : flags < 3 ? "MEDIUM" : "HIGH";
}

export function baseline(eventType: string, payload: Record<string, unknown>): Baseline {
  if (TERMINAL_PREFIXES.some((p) => eventType.startsWith(p))) {
    return { sensitivity: "INTERNAL", severity: "INFO", needsStage2: false, terminal: true };
  }
  const external = EXTERNAL[eventType];
  if (external !== undefined)
    return { sensitivity: "CONFIDENTIAL", severity: external, needsStage2: true, terminal: false };
  if (eventType === "txn.submitted")
    return { sensitivity: "CONFIDENTIAL", severity: "LOW", needsStage2: false, terminal: false };
  if (eventType.startsWith("file.") || eventType === "doc.file.ready") {
    return { sensitivity: "INTERNAL", severity: "INFO", needsStage2: false, terminal: false };
  }
  if (eventType === "doc.extraction.completed" || eventType === "doc.extraction.review_required") {
    const excerpt = payload["textExcerpt"];
    return {
      sensitivity: "CONFIDENTIAL",
      severity: redFlagSeverity(payload),
      needsStage2: typeof excerpt === "string" && excerpt.trim() !== "",
      terminal: false,
    };
  }
  if (eventType === "risk.evaluation.recorded") {
    const band = payload["band"];
    return {
      sensitivity: "CONFIDENTIAL",
      severity: isSeverity(band) ? band : "LOW",
      needsStage2: false,
      terminal: false,
    };
  }
  if (eventType.startsWith("case.")) {
    const sev = payload["severity"];
    return {
      sensitivity: "CONFIDENTIAL",
      severity: isSeverity(sev) ? sev : "MEDIUM",
      needsStage2: false,
      terminal: false,
    };
  }
  return { sensitivity: "UNCLASSIFIED", severity: "LOW", needsStage2: true, terminal: false };
}

// ── Detectors ────────────────────────────────────────────────────────────────

const AWS_KEY = /AKIA[0-9A-Z]{16}/g;
const PEM_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const SLACK_TOKEN = /xox[baprs]-[A-Za-z0-9-]+/g;
const GENERIC_SECRET = /((?:api[_-]?key|secret|password)\s*[:=]\s*["']?)([^\s"',;]{16,})/gi;
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;
const SSN = /\b(\d{3})-(\d{2})-(\d{4})\b/g;
const PII_KEYS = new Set(["ssn", "dob", "taxid", "passportnumber", "accountnumber"]);
const SECRET_KEYS = /^(api[_-]?key|secret|password)$/i;
const MNPI = ["material non-public", "embargoed until", "not for distribution", "pre-announcement"];

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function lastFour(value: string): string {
  const keep = value.slice(-4);
  return `${"*".repeat(Math.max(value.length - 4, 4))}${keep}`;
}

interface Findings {
  sensitivity: Sensitivity;
  severity: Severity;
  categories: Set<Category>;
  redactions: Redaction[];
}

function scanString(text: string, path: string, f: Findings): string {
  let out = text;
  const mark = (rule: string, category: Category, raise?: Severity): void => {
    f.sensitivity = "RESTRICTED";
    f.categories.add(category);
    if (raise !== undefined) f.severity = maxSeverity(f.severity, raise);
    if (!f.redactions.some((r) => r.path === path && r.rule === rule)) f.redactions.push({ path, rule, kind: "MASK" });
  };
  out = out.replace(AWS_KEY, () => (mark("secret.aws_access_key", "SECRET", "HIGH"), "AKIA****************"));
  out = out.replace(
    PEM_HEADER,
    () => (mark("secret.pem_private_key", "SECRET", "HIGH"), "-----BEGIN [MASKED] PRIVATE KEY-----"),
  );
  out = out.replace(SLACK_TOKEN, (m) => (mark("secret.slack_token", "SECRET", "HIGH"), `${m.slice(0, 5)}****`));
  out = out.replace(
    GENERIC_SECRET,
    (_m, lead: string) => (mark("secret.generic_assignment", "SECRET", "HIGH"), `${lead}****`),
  );
  out = out.replace(CARD_CANDIDATE, (m) => {
    const digits = m.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return m;
    mark("pii.payment_card", "PII");
    return lastFour(digits);
  });
  out = out.replace(SSN, (m, area: string, group: string, serial: string) => {
    if (area === "000" || area === "666" || area.startsWith("9") || group === "00" || serial === "0000") return m;
    mark("pii.us_ssn", "PII");
    return `***-**-${serial}`;
  });
  const lower = out.toLowerCase();
  if (MNPI.some((phrase) => lower.includes(phrase))) {
    f.categories.add("MNPI");
    f.sensitivity = maxSensitivity(f.sensitivity, "CONFIDENTIAL");
    f.severity = maxSeverity(f.severity, "HIGH");
  }
  return out;
}

function walk(value: unknown, path: string, key: string | undefined, f: Findings): unknown {
  if (typeof value === "string") {
    if (key !== undefined && PII_KEYS.has(key.toLowerCase())) {
      f.sensitivity = "RESTRICTED";
      f.categories.add("PII");
      f.redactions.push({ path, rule: `pii.key.${key}`, kind: "MASK" });
      return lastFour(value);
    }
    if (key !== undefined && SECRET_KEYS.test(key) && value.length >= 16) {
      f.sensitivity = "RESTRICTED";
      f.categories.add("SECRET");
      f.severity = maxSeverity(f.severity, "HIGH");
      f.redactions.push({ path, rule: "secret.named_field", kind: "MASK" });
      return "****";
    }
    return scanString(value, path, f);
  }
  if (typeof value === "number" && key !== undefined && PII_KEYS.has(key.toLowerCase())) {
    f.sensitivity = "RESTRICTED";
    f.categories.add("PII");
    f.redactions.push({ path, rule: `pii.key.${key}`, kind: "MASK" });
    return lastFour(String(value));
  }
  if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${String(i)}]`, key, f));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, `${path}.${k}`, k, f);
    return out;
  }
  return value;
}

export function classifyStage1(eventType: string, payload: Record<string, unknown>): Stage1Result {
  const base = baseline(eventType, payload);
  const f: Findings = { sensitivity: base.sensitivity, severity: base.severity, categories: new Set(), redactions: [] };
  const redacted = walk(payload, "payload", undefined, f) as Record<string, unknown>;
  return {
    sensitivity: f.sensitivity,
    categories: [...f.categories].sort(),
    severity: f.severity,
    needsStage2: base.needsStage2,
    terminal: base.terminal,
    payload: redacted,
    redactions: f.redactions,
  };
}

/**
 * Masks every rules-v1 detector hit in an arbitrary value (same detectors and masks as Stage 1), without classifying.
 * Used for views of stored messages that never went through Stage 1, e.g. dead letters (FR-MSG-03, §1.4.2).
 */
export function maskValue(value: unknown, root: string): { value: unknown; redactions: Redaction[] } {
  const f: Findings = { sensitivity: "PUBLIC", severity: "INFO", categories: new Set(), redactions: [] };
  return { value: walk(value, root, undefined, f), redactions: f.redactions };
}
