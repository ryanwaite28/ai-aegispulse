import { describe, expect, it } from "vitest";
import { baseline, classifyStage1 } from "./rules-v1.js";

describe("rules-v1.0.0 baseline (§1.4.2)", () => {
  it.each([
    ["external.regulatory.published", {}, "CONFIDENTIAL", "MEDIUM", true, false],
    ["external.ipo.filed", {}, "CONFIDENTIAL", "MEDIUM", true, false],
    ["external.acquisition.announced", {}, "CONFIDENTIAL", "HIGH", true, false],
    ["external.market.alert", {}, "CONFIDENTIAL", "MEDIUM", true, false],
    ["external.compliance.disclosed", {}, "CONFIDENTIAL", "HIGH", true, false],
    ["txn.submitted", {}, "CONFIDENTIAL", "LOW", false, false],
    ["file.uploaded", {}, "INTERNAL", "INFO", false, false],
    ["doc.file.ready", {}, "INTERNAL", "INFO", false, false],
    ["doc.extraction.completed", { redFlags: [], textExcerpt: "x" }, "CONFIDENTIAL", "LOW", true, false],
    ["doc.extraction.completed", { redFlags: ["a", "b"] }, "CONFIDENTIAL", "MEDIUM", false, false],
    [
      "doc.extraction.review_required",
      { redFlags: ["a", "b", "c"], textExcerpt: "x" },
      "CONFIDENTIAL",
      "HIGH",
      true,
      false,
    ],
    ["risk.evaluation.recorded", { band: "CRITICAL" }, "CONFIDENTIAL", "CRITICAL", false, false],
    ["case.opened", { severity: "HIGH" }, "CONFIDENTIAL", "HIGH", false, false],
    ["classification.finalized", {}, "INTERNAL", "INFO", false, true],
    ["intel.drift.detected", {}, "INTERNAL", "INFO", false, true],
    ["ops.audit.file_deleted", {}, "INTERNAL", "INFO", false, true],
    ["registry.tenant.created", {}, "INTERNAL", "INFO", false, true],
    ["correlation.requested", {}, "INTERNAL", "INFO", false, true],
    ["notification.requested", {}, "INTERNAL", "INFO", false, true],
    ["something.else", {}, "UNCLASSIFIED", "LOW", true, false],
  ])("%s %j → %s / %s / stage2=%s / terminal=%s", (type, payload, sensitivity, severity, needsStage2, terminal) => {
    expect(baseline(type, payload)).toEqual({ sensitivity, severity, needsStage2, terminal });
  });
});

describe("rules-v1.0.0 detectors and masking (§1.4.2 elevation rules)", () => {
  it("masks secrets (AWS key, PEM header, Slack token, generic assignment) → RESTRICTED, SECRET, ≥ HIGH", () => {
    // Synthetic look-alikes, assembled at runtime so secret scanners (gitleaks pre-commit) do not flag the source.
    const fakeAwsKey = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
    const fakePem = ["-----BEGIN RSA ", "PRIVATE KEY-----"].join("");
    const r = classifyStage1("external.market.alert", {
      title: "leak",
      body: `creds ${fakeAwsKey} and ${fakePem} xoxb-1234-abcd password=SuperSecretValue123!`,
    });
    expect(r.sensitivity).toBe("RESTRICTED");
    expect(r.categories).toContain("SECRET");
    expect(r.severity).toBe("HIGH");
    expect(r.payload["body"]).toBe(
      "creds AKIA**************** and -----BEGIN [MASKED] PRIVATE KEY----- xoxb-**** password=****",
    );
    expect(r.redactions.map((x) => x.rule).sort()).toEqual([
      "secret.aws_access_key",
      "secret.generic_assignment",
      "secret.pem_private_key",
      "secret.slack_token",
    ]);
    expect(r.redactions.every((x) => x.path === "payload.body" && x.kind === "MASK")).toBe(true);
  });

  it("masks a Luhn-valid card to its last 4 and a US SSN; Luhn-invalid digits and excluded SSN areas stay", () => {
    const r = classifyStage1("txn.submitted", {
      note: "card 4111 1111 1111 1111, ref 4111111111111112, ssn 123-45-6789, test 666-12-3456, 900-12-3456",
    });
    expect(r.payload["note"]).toBe(
      "card ************1111, ref 4111111111111112, ssn ***-**-6789, test 666-12-3456, 900-12-3456",
    );
    expect(r.sensitivity).toBe("RESTRICTED");
    expect(r.categories).toEqual(["PII"]);
    expect(r.severity).toBe("LOW"); // PII raises sensitivity, not severity
  });

  it("masks PII-named keys (strings and numbers, nested and in arrays) with dotted paths", () => {
    const r = classifyStage1("txn.submitted", {
      customer: { ssn: "123456789", dob: "1990-01-02", contacts: [{ accountNumber: 12345678 }] },
      taxId: "AB-998877",
    });
    expect(r.payload).toEqual({
      customer: { ssn: "*****6789", dob: "******1-02", contacts: [{ accountNumber: "****5678" }] },
      taxId: "*****8877",
    });
    expect(r.redactions.map((x) => x.path).sort()).toEqual([
      "payload.customer.contacts[0].accountNumber",
      "payload.customer.dob",
      "payload.customer.ssn",
      "payload.taxId",
    ]);
  });

  it("MNPI lexicon → category MNPI, sensitivity ≥ CONFIDENTIAL, severity ≥ HIGH, not masked", () => {
    const r = classifyStage1("something.else", { summary: "Embargoed until 9am: pre-announcement figures" });
    expect(r.categories).toEqual(["MNPI"]);
    expect(r.sensitivity).toBe("CONFIDENTIAL");
    expect(r.severity).toBe("HIGH");
    expect(r.payload["summary"]).toBe("Embargoed until 9am: pre-announcement figures");
    expect(r.redactions).toEqual([]);
  });

  it("leaves ordinary payloads untouched (uuids, hex hashes, ISO dates, short numbers)", () => {
    const payload = {
      fileId: "1c9e0f4a-7a33-4b44-9c6d-7e8f9a0b1c2d",
      sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      publishedAt: "2026-11-24T12:00:00Z",
      amount: "1250.00",
      tickers: ["ACMH"],
    };
    const r = classifyStage1("external.market.alert", payload);
    expect(r.payload).toEqual(payload);
    expect(r.redactions).toEqual([]);
    expect(r.sensitivity).toBe("CONFIDENTIAL");
  });

  it("FR-CLS-01 budget: p95 ≤ 5 ms per event", () => {
    const payload = {
      externalId: "rel-2026-8841",
      category: "MARKET_ALERT",
      title: "Unusual trading volume in ACMH ahead of earnings",
      summary: "Desk notes ".repeat(60),
      mentionedEntities: ["ACME Holdings", "Globex Clearing"],
      tickers: ["ACMH", "GLBX"],
      nested: { contacts: [{ name: "x", phone: "555-0100" }], notes: "card 4111 1111 1111 1111" },
    };
    const samples: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const t = process.hrtime.bigint();
      classifyStage1("external.market.alert", payload);
      samples.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? Infinity;
    expect(p95).toBeLessThanOrEqual(5);
  });
});
