import { describe, expect, it } from "vitest";
import { resolveSeverity } from "./severity-resolver.js";
import { SEVERITIES, severityAtLeast, type Severity } from "./severity.js";

const opt = <T>(xs: readonly T[]): (T | undefined)[] => [undefined, ...xs];

describe("severity-resolver-v1 (§1.4.3, FR-CLS-02)", () => {
  it("is elevate-only for every automated combination (exhaustive: rule × ai × confidence × publisher × trust)", () => {
    let checked = 0;
    for (const rule of SEVERITIES) {
      for (const aiSev of opt(SEVERITIES)) {
        for (const confidence of [0.2, 0.59, 0.6, 0.95]) {
          for (const publisher of [null, ...SEVERITIES] as (Severity | null)[]) {
            for (const trustedSource of [true, false]) {
              const ai = aiSev === undefined ? undefined : { severity: aiSev, confidence };
              const r = resolveSeverity({ rule, ai, publisher, trustedSource });
              // Never below the rule result; final never below algorithm.
              expect(severityAtLeast(r.algorithm, rule)).toBe(true);
              expect(severityAtLeast(r.final, r.algorithm)).toBe(true);
              // AI counts only at confidence ≥ 0.60; publisher only for TRUSTED sources.
              if (ai !== undefined && confidence >= 0.6) expect(severityAtLeast(r.algorithm, ai.severity)).toBe(true);
              else expect(r.algorithm).toBe(rule);
              if (!trustedSource || publisher === null) expect(r.final).toBe(r.algorithm);
              else expect(severityAtLeast(r.final, publisher)).toBe(true);
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBe(5 * 6 * 4 * 6 * 2);
  });

  it("source is RULES unless a confident AI result was used; an analyst override wins (and may lower)", () => {
    expect(resolveSeverity({ rule: "LOW", publisher: null, trustedSource: false }).source).toBe("RULES");
    expect(
      resolveSeverity({
        rule: "LOW",
        ai: { severity: "HIGH", confidence: 0.5 },
        publisher: null,
        trustedSource: false,
      }),
    ).toEqual({
      algorithm: "LOW",
      final: "LOW",
      source: "RULES",
    });
    expect(
      resolveSeverity({
        rule: "LOW",
        ai: { severity: "HIGH", confidence: 0.8 },
        publisher: "CRITICAL",
        trustedSource: true,
      }),
    ).toEqual({
      algorithm: "HIGH",
      final: "CRITICAL",
      source: "AI_SCANNER",
    });
    expect(resolveSeverity({ rule: "HIGH", publisher: "CRITICAL", trustedSource: true, override: "LOW" })).toEqual({
      algorithm: "HIGH",
      final: "LOW",
      source: "ANALYST",
    });
  });
});
