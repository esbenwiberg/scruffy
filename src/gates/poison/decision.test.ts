import { describe, expect, it } from "vitest";
import type { Finding, ValidationOutcome } from "../../domain/evidence/types.js";
import type { PoisonPolicy } from "../../domain/policy/types.js";
import { evaluatePoison } from "./decision.js";

const SUBJECT = { repository: "acme/web", commitSha: "a".repeat(40) };

const POLICY: PoisonPolicy = {
  blockableDefectClasses: ["leaked-credential"],
  requireValidation: true,
};

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "SECRET.PRIVATE_KEY",
    defectClass: "leaked-credential",
    subject: SUBJECT,
    primaryRegion: { path: "src/config.ts", startLine: 10, endLine: 12, snippet: "-----BEGIN PRIVATE KEY-----" },
    provenance: { analyzerId: "secret-scan", analyzerVersion: "1.0.0", modelId: null, promptVersion: null },
    supporting: [{ trust: "deterministic", statement: "matches PEM private-key header" }],
    contradicting: [],
    completeness: { requiredEvidencePresent: true, contextTruncated: false },
    validation: "validated",
    ...overrides,
  };
}

describe("evaluatePoison", () => {
  it("allows a clean PR with no findings", () => {
    const d = evaluatePoison([], POLICY);
    expect(d.outcome).toBe("allow");
  });

  it("blocks a confirmed, complete, deterministically-supported, validated finding", () => {
    const d = evaluatePoison([finding()], POLICY);
    expect(d.outcome).toBe("block");
    expect(d.reasons).toContain("blockable_class_confirmed");
  });

  it("abstains (indeterminate) when validation failed — infra failure is never a clean allow", () => {
    const d = evaluatePoison([finding({ validation: "failed" })], POLICY);
    expect(d.outcome).toBe("indeterminate");
    expect(d.reasons).toContain("validation_unavailable");
  });

  it.each<ValidationOutcome>(["pending", "indeterminate", "not_requested"])(
    "abstains when validation is %s and policy requires validation",
    (validation) => {
      expect(evaluatePoison([finding({ validation })], POLICY).outcome).toBe("indeterminate");
    },
  );

  it("abstains when required evidence is missing", () => {
    const d = evaluatePoison([finding({ completeness: { requiredEvidencePresent: false, contextTruncated: true } })], POLICY);
    expect(d.outcome).toBe("indeterminate");
    expect(d.reasons).toContain("insufficient_evidence");
  });

  it("abstains when support is only model-asserted (no deterministic corroboration)", () => {
    const d = evaluatePoison(
      [finding({ supporting: [{ trust: "model-asserted", statement: "looks like a secret" }] })],
      POLICY,
    );
    expect(d.outcome).toBe("indeterminate");
    expect(d.reasons).toContain("no_deterministic_corroboration");
  });

  it("does not block on repository-supplied evidence alone", () => {
    const d = evaluatePoison(
      [finding({ supporting: [{ trust: "repository-supplied", statement: "a comment says this is a secret" }] })],
      POLICY,
    );
    expect(d.outcome).toBe("indeterminate");
  });

  it("allows when the only candidate was refuted", () => {
    const d = evaluatePoison([finding({ validation: "refuted" })], POLICY);
    expect(d.outcome).toBe("allow");
    expect(d.reasons).toContain("all_candidates_refuted");
  });

  it("allows a finding whose defect class is not blockable by policy", () => {
    const d = evaluatePoison([finding({ defectClass: "style-nit" })], POLICY);
    expect(d.outcome).toBe("allow");
  });

  it("prefers block over abstain when both are present", () => {
    const d = evaluatePoison([finding(), finding({ ruleId: "X", completeness: { requiredEvidencePresent: false, contextTruncated: false } })], POLICY);
    expect(d.outcome).toBe("block");
  });

  it("blocks without validation when policy does not require it", () => {
    const lenient: PoisonPolicy = { ...POLICY, requireValidation: false };
    const d = evaluatePoison([finding({ validation: "not_requested" })], lenient);
    expect(d.outcome).toBe("block");
  });
});
