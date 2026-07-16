import { describe, expect, it } from "vitest";
import type { Finding, ValidationOutcome } from "../../domain/evidence/types.js";
import type { NightlyPolicy } from "../../domain/policy/types.js";
import { evaluateNightly } from "./decision.js";

const SUBJECT = { repository: "acme/web", commitSha: "a".repeat(40) };

const POLICY: NightlyPolicy = {
  reportableDefectClasses: ["leaked-credential", "disabled-tls-verification"],
  fixableDefectClasses: ["disabled-tls-verification"],
};

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "TLS.REJECT_UNAUTHORIZED_FALSE",
    defectClass: "disabled-tls-verification",
    subject: SUBJECT,
    primaryRegion: { path: "src/http.ts", startLine: 5, endLine: 5, snippet: "rejectUnauthorized: false" },
    provenance: { analyzerId: "disabled-tls", analyzerVersion: "1.0.0", modelId: null, promptVersion: null },
    supporting: [{ trust: "deterministic", statement: "disables TLS verification" }],
    contradicting: [],
    completeness: { requiredEvidencePresent: true, contextTruncated: false },
    validation: "validated",
    ...overrides,
  };
}

describe("evaluateNightly", () => {
  it("proposes a fix for a validated, deterministically-supported, fixable class", () => {
    const d = evaluateNightly([finding()], POLICY);
    expect(d.dispositions[0]!.disposition).toBe("propose_fix");
    expect(d.dispositions[0]!.reason).toBe("fixable_validated");
    expect(d.summary).toEqual({ reported: 0, proposedFixes: 1, suppressed: 0 });
  });

  it("reports (not fix) a validated finding whose class is reportable but not fixable", () => {
    const d = evaluateNightly(
      [finding({ defectClass: "leaked-credential", ruleId: "SECRET.AWS_KEY" })],
      POLICY,
    );
    expect(d.dispositions[0]!.disposition).toBe("report");
    expect(d.dispositions[0]!.reason).toBe("reportable_validated");
  });

  it("reports but never auto-fixes a finding it could not validate", () => {
    for (const v of ["pending", "indeterminate", "failed", "not_requested"] as ValidationOutcome[]) {
      const d = evaluateNightly([finding({ validation: v })], POLICY);
      expect(d.dispositions[0]!.disposition).toBe("report");
      expect(d.dispositions[0]!.reason).toBe("reportable_unvalidated");
    }
  });

  it("does not propose a fix on model-only support even when validated", () => {
    const d = evaluateNightly(
      [finding({ supporting: [{ trust: "model-asserted", statement: "looks like a MITM" }] })],
      POLICY,
    );
    expect(d.dispositions[0]!.disposition).toBe("report");
    expect(d.dispositions[0]!.reason).toBe("reportable_validated");
  });

  it("suppresses a refuted finding", () => {
    const d = evaluateNightly([finding({ validation: "refuted" })], POLICY);
    expect(d.dispositions[0]!.disposition).toBe("suppress");
    expect(d.dispositions[0]!.reason).toBe("refuted");
  });

  it("suppresses a non-reportable class", () => {
    const d = evaluateNightly([finding({ defectClass: "style-nit" })], POLICY);
    expect(d.dispositions[0]!.disposition).toBe("suppress");
    expect(d.dispositions[0]!.reason).toBe("not_reportable_class");
  });

  it("ranks propose_fix before report before suppress, deterministically", () => {
    const reported = finding({ defectClass: "leaked-credential", ruleId: "SECRET.AWS_KEY", primaryRegion: { path: "src/z.ts", startLine: 1, endLine: 1, snippet: "x" } });
    const suppressed = finding({ validation: "refuted" });
    const proposed = finding();
    const d = evaluateNightly([suppressed, reported, proposed], POLICY);
    expect(d.dispositions.map((x) => x.disposition)).toEqual(["propose_fix", "report", "suppress"]);
  });

  it("is order-independent: shuffled input yields the same ranked output", () => {
    const a = finding({ ruleId: "TLS.A", primaryRegion: { path: "src/a.ts", startLine: 1, endLine: 1, snippet: "rejectUnauthorized: false" } });
    const b = finding({ ruleId: "TLS.B", primaryRegion: { path: "src/b.ts", startLine: 2, endLine: 2, snippet: "rejectUnauthorized: false" } });
    const forward = evaluateNightly([a, b], POLICY).dispositions.map((x) => x.ruleId);
    const backward = evaluateNightly([b, a], POLICY).dispositions.map((x) => x.ruleId);
    expect(forward).toEqual(backward);
  });

  it("an empty range is a clean nightly", () => {
    const d = evaluateNightly([], POLICY);
    expect(d.dispositions).toEqual([]);
    expect(d.summary).toEqual({ reported: 0, proposedFixes: 0, suppressed: 0 });
  });
});
