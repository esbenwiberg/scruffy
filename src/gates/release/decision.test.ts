import { describe, expect, it } from "vitest";
import type { Finding, ValidationOutcome } from "../../domain/evidence/types.js";
import type { ReleasePolicy } from "../../domain/policy/types.js";
import { evaluateRelease } from "./decision.js";
import { COMPLETE_COVERAGE } from "../../domain/evidence/coverage.js";

const SUBJECT = { repository: "acme/web", commitSha: "a".repeat(40) };

const POLICY: ReleasePolicy = {
  stopDefectClasses: ["leaked-credential", "destructive-schema-change"],
  signoffDefectClasses: ["disabled-tls-verification", "sql-injection"],
  evidence: {
    "source-analysis": { applicable: true, required: true },
    "release-risk-llm": { applicable: true, required: true },
    "candidate-ci": { applicable: true, required: true, requiredContexts: ["ci/build"] },
  },
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
    const d = evaluateRelease([], POLICY, COMPLETE_COVERAGE);
    expect(d.outcome).toBe("ship");
    expect(d.reasons).toEqual(["no_release_findings"]);
    expect(d.summary).toEqual({ stopped: 0, escalated: 0, cleared: 0, notRelevant: 0 });
  });

  it("stops on a confirmed stop-class finding", () => {
    const d = evaluateRelease([secret()], POLICY, COMPLETE_COVERAGE);
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
      COMPLETE_COVERAGE,
    );
    expect(d.outcome).toBe("sign-off-required");
    expect(d.reasons).toContain("stop_class_unconfirmed");
  });

  it("escalates an unconfirmed stop-class finding (e.g. validation indeterminate) rather than fabricating a stop", () => {
    for (const v of ["pending", "indeterminate", "failed", "not_requested"] as ValidationOutcome[]) {
      const d = evaluateRelease([secret({ validation: v })], POLICY, COMPLETE_COVERAGE);
      expect(d.outcome).toBe("sign-off-required");
      expect(d.dispositions[0]!.reason).toBe("stop_class_unconfirmed");
    }
  });

  it("escalates incomplete-evidence stop-class findings rather than shipping them", () => {
    const d = evaluateRelease([secret({ completeness: { requiredEvidencePresent: false, contextTruncated: true } })], POLICY, COMPLETE_COVERAGE);
    expect(d.outcome).toBe("sign-off-required");
    expect(d.dispositions[0]!.reason).toBe("stop_class_unconfirmed");
  });

  it("requires sign-off for a confirmed sign-off-class finding (serious but human-adjudicable)", () => {
    const d = evaluateRelease([tls()], POLICY, COMPLETE_COVERAGE);
    expect(d.outcome).toBe("sign-off-required");
    expect(d.dispositions[0]!.reason).toBe("signoff_class_confirmed");
  });

  it("requires sign-off for an unconfirmed sign-off-class finding too", () => {
    const d = evaluateRelease([tls({ validation: "pending" })], POLICY, COMPLETE_COVERAGE);
    expect(d.outcome).toBe("sign-off-required");
    expect(d.dispositions[0]!.reason).toBe("signoff_class_unconfirmed");
  });

  it("ships when the only findings were refuted by the adversarial validator", () => {
    const d = evaluateRelease([tls({ validation: "refuted" }), secret({ validation: "refuted" })], POLICY, COMPLETE_COVERAGE);
    expect(d.outcome).toBe("ship");
    expect(d.reasons).toEqual(["finding_refuted"]);
    expect(d.summary.cleared).toBe(2);
  });

  it("ships when findings are all release-irrelevant classes", () => {
    const d = evaluateRelease([secret({ defectClass: "style-nit" })], POLICY, COMPLETE_COVERAGE);
    expect(d.outcome).toBe("ship");
    expect(d.reasons).toEqual(["not_release_relevant"]);
    expect(d.summary.notRelevant).toBe(1);
  });

  it("stop dominates sign-off when both are present in the range", () => {
    const d = evaluateRelease([tls(), secret()], POLICY, COMPLETE_COVERAGE);
    expect(d.outcome).toBe("stop");
    // Ranked most-severe first: the stop leads.
    expect(d.dispositions[0]!.effect).toBe("stops");
    expect(d.summary).toEqual({ stopped: 1, escalated: 1, cleared: 0, notRelevant: 0 });
  });

  it("model risk escalates but never stops", () => {
    // A retained range-level model risk is unresolved and model-asserted, so it
    // forces human sign-off — never a silent ship, never a fabricated stop.
    const withRisk = evaluateRelease([], POLICY, COMPLETE_COVERAGE, { retainedRiskCount: 1, complete: true });
    expect(withRisk.outcome).toBe("sign-off-required");
    expect(withRisk.reasons).toContain("model_risk_present");

    // An incomplete LLM lane (no retained risk) also escalates — blind is not clean.
    const incompleteLane = evaluateRelease([], POLICY, COMPLETE_COVERAGE, { retainedRiskCount: 0, complete: false });
    expect(incompleteLane.outcome).toBe("sign-off-required");
    expect(incompleteLane.reasons).toContain("llm_lane_incomplete");

    // A separately CONFIRMED deterministic stop still produces `stop`, even when
    // the LLM lane also has retained risk AND is incomplete. Deterministic stop
    // wins; a model risk can never soften it, and never manufactures a stop.
    const stopWins = evaluateRelease([secret()], POLICY, COMPLETE_COVERAGE, { retainedRiskCount: 3, complete: false });
    expect(stopWins.outcome).toBe("stop");
    expect(stopWins.reasons).toContain("stop_class_confirmed");
    expect(stopWins.reasons).not.toContain("model_risk_present");
  });

  it("incomplete required candidate-CI lane escalates to sign-off", () => {
    // A required candidate-CI lane that did not cleanly pass every context is blind,
    // and blind is not clean: escalate to a human, never a silent ship.
    const d = evaluateRelease([], POLICY, COMPLETE_COVERAGE, undefined, { required: true, complete: false });
    expect(d.outcome).toBe("sign-off-required");
    expect(d.reasons).toContain("ci_lane_incomplete");

    // A complete required CI lane over an otherwise clean range ships.
    const clean = evaluateRelease([], POLICY, COMPLETE_COVERAGE, undefined, { required: true, complete: true });
    expect(clean.outcome).toBe("ship");

    // A NON-required (e.g. not-applicable) incomplete lane never holds a release.
    const notRequired = evaluateRelease([], POLICY, COMPLETE_COVERAGE, undefined, { required: false, complete: false });
    expect(notRequired.outcome).toBe("ship");
  });

  it("confirmed stop wins over incomplete required lanes", () => {
    // A confirmed deterministic stop must remain `stop` even when other required
    // evidence lanes are incomplete — a failed LLM lane AND a failed/missing CI
    // lane cannot soften a confirmed catastrophe, and neither lane manufactures one.
    const withFailedLlm = evaluateRelease(
      [secret()],
      POLICY,
      COMPLETE_COVERAGE,
      { retainedRiskCount: 2, complete: false }, // LLM lane has risk AND is incomplete
      { required: true, complete: true },
    );
    expect(withFailedLlm.outcome).toBe("stop");
    expect(withFailedLlm.reasons).toContain("stop_class_confirmed");
    expect(withFailedLlm.reasons).not.toContain("model_risk_present");
    expect(withFailedLlm.reasons).not.toContain("llm_lane_incomplete");

    const withFailedCi = evaluateRelease(
      [secret()],
      POLICY,
      COMPLETE_COVERAGE,
      undefined,
      { required: true, complete: false }, // required CI lane incomplete
    );
    expect(withFailedCi.outcome).toBe("stop");
    expect(withFailedCi.reasons).toContain("stop_class_confirmed");
    expect(withFailedCi.reasons).not.toContain("ci_lane_incomplete");

    // Both LLM and CI lanes incomplete at once: still `stop`.
    const bothIncomplete = evaluateRelease(
      [secret()],
      POLICY,
      COMPLETE_COVERAGE,
      { retainedRiskCount: 1, complete: false },
      { required: true, complete: false },
    );
    expect(bothIncomplete.outcome).toBe("stop");
  });

  it("is order-independent: shuffled input yields the same ranked output and outcome", () => {
    const a = tls({ ruleId: "TLS.A", primaryRegion: { path: "src/a.ts", startLine: 1, endLine: 1, snippet: "x" } });
    const b = secret({ ruleId: "SECRET.B", primaryRegion: { path: "src/b.ts", startLine: 2, endLine: 2, snippet: "y" } });
    const forward = evaluateRelease([a, b], POLICY, COMPLETE_COVERAGE);
    const backward = evaluateRelease([b, a], POLICY, COMPLETE_COVERAGE);
    expect(forward.outcome).toBe(backward.outcome);
    expect(forward.dispositions.map((x) => x.ruleId)).toEqual(backward.dispositions.map((x) => x.ruleId));
  });
});
