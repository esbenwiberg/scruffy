import { describe, expect, it } from "vitest";
import type { Finding, ValidationOutcome } from "../../domain/evidence/types.js";
import type { ReleasePolicy } from "../../domain/policy/types.js";
import { evaluateRelease } from "./decision.js";

const SUBJECT = { repository: "acme/web", commitSha: "a".repeat(40) };

const POLICY: ReleasePolicy = {
  stopDefectClasses: ["leaked-credential", "destructive-schema-change"],
  signoffDefectClasses: ["disabled-tls-verification", "sql-injection"],
};

/** A confirmed leaked credential (validated + deterministic + complete). */
function secret(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "SECRET.AWS_KEY",
    defectClass: "leaked-credential",
    subject: SUBJECT,
    primaryRegion: { path: "src/config.ts", startLine: 1, endLine: 1, snippet: "AKIA..." },
    provenance: { analyzerId: "secret-scan", analyzerVersion: "1.0.0", modelId: null, promptVersion: null },
    supporting: [{ trust: "deterministic", statement: "high-entropy AWS key" }],
    contradicting: [],
    completeness: { requiredEvidencePresent: true, contextTruncated: false },
    validation: "validated",
    ...overrides,
  };
}

/** A confirmed disabled-TLS finding (a sign-off class). */
function tls(overrides: Partial<Finding> = {}): Finding {
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

describe("evaluateRelease", () => {
  it("ships an empty range", () => {
    const d = evaluateRelease([], POLICY);
    expect(d.outcome).toBe("ship");
    expect(d.reasons).toEqual(["no_release_findings"]);
    expect(d.summary).toEqual({ stopped: 0, escalated: 0, cleared: 0, notRelevant: 0 });
  });

  it("stops on a confirmed stop-class finding", () => {
    const d = evaluateRelease([secret()], POLICY);
    expect(d.outcome).toBe("stop");
    expect(d.reasons).toContain("stop_class_confirmed");
    expect(d.dispositions[0]!.effect).toBe("stops");
  });

  it("never stops on model-only support, even when validated: escalates instead", () => {
    // A model-asserted 'confirmed' catastrophe lacks deterministic support, so it
    // is NOT confirmed — it must not hard-stop; it escalates to a human.
    const d = evaluateRelease(
      [secret({ supporting: [{ trust: "model-asserted", statement: "looks like a live key" }] })],
      POLICY,
    );
    expect(d.outcome).toBe("sign-off-required");
    expect(d.reasons).toContain("stop_class_unconfirmed");
  });

  it("escalates an unconfirmed stop-class finding (e.g. validation indeterminate) rather than fabricating a stop", () => {
    for (const v of ["pending", "indeterminate", "failed", "not_requested"] as ValidationOutcome[]) {
      const d = evaluateRelease([secret({ validation: v })], POLICY);
      expect(d.outcome).toBe("sign-off-required");
      expect(d.dispositions[0]!.reason).toBe("stop_class_unconfirmed");
    }
  });

  it("escalates incomplete-evidence stop-class findings rather than shipping them", () => {
    const d = evaluateRelease([secret({ completeness: { requiredEvidencePresent: false, contextTruncated: true } })], POLICY);
    expect(d.outcome).toBe("sign-off-required");
    expect(d.dispositions[0]!.reason).toBe("stop_class_unconfirmed");
  });

  it("requires sign-off for a confirmed sign-off-class finding (serious but human-adjudicable)", () => {
    const d = evaluateRelease([tls()], POLICY);
    expect(d.outcome).toBe("sign-off-required");
    expect(d.dispositions[0]!.reason).toBe("signoff_class_confirmed");
  });

  it("requires sign-off for an unconfirmed sign-off-class finding too", () => {
    const d = evaluateRelease([tls({ validation: "pending" })], POLICY);
    expect(d.outcome).toBe("sign-off-required");
    expect(d.dispositions[0]!.reason).toBe("signoff_class_unconfirmed");
  });

  it("ships when the only findings were refuted by the adversarial validator", () => {
    const d = evaluateRelease([tls({ validation: "refuted" }), secret({ validation: "refuted" })], POLICY);
    expect(d.outcome).toBe("ship");
    expect(d.reasons).toEqual(["finding_refuted"]);
    expect(d.summary.cleared).toBe(2);
  });

  it("ships when findings are all release-irrelevant classes", () => {
    const d = evaluateRelease([secret({ defectClass: "style-nit" })], POLICY);
    expect(d.outcome).toBe("ship");
    expect(d.reasons).toEqual(["not_release_relevant"]);
    expect(d.summary.notRelevant).toBe(1);
  });

  it("stop dominates sign-off when both are present in the range", () => {
    const d = evaluateRelease([tls(), secret()], POLICY);
    expect(d.outcome).toBe("stop");
    // Ranked most-severe first: the stop leads.
    expect(d.dispositions[0]!.effect).toBe("stops");
    expect(d.summary).toEqual({ stopped: 1, escalated: 1, cleared: 0, notRelevant: 0 });
  });

  it("is order-independent: shuffled input yields the same ranked output and outcome", () => {
    const a = tls({ ruleId: "TLS.A", primaryRegion: { path: "src/a.ts", startLine: 1, endLine: 1, snippet: "x" } });
    const b = secret({ ruleId: "SECRET.B", primaryRegion: { path: "src/b.ts", startLine: 2, endLine: 2, snippet: "y" } });
    const forward = evaluateRelease([a, b], POLICY);
    const backward = evaluateRelease([b, a], POLICY);
    expect(forward.outcome).toBe(backward.outcome);
    expect(forward.dispositions.map((x) => x.ruleId)).toEqual(backward.dispositions.map((x) => x.ruleId));
  });
});
