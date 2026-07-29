import { describe, expect, it } from "vitest";
import { NightlyPolicy, ReleasePolicy } from "../../../src/domain/policy/types.js";

/**
 * The cross-list invariants are documented as MUST requirements, so the schemas
 * must reject a mis-authored policy version at the boundary — an EffectivePolicy is
 * immutable per version and cited by every decision, so a violation accepted here
 * would be baked into every decision that version produces.
 */
describe("NightlyPolicy: fixable ⊆ reportable", () => {
  it("accepts a policy where every fixable class is also reportable", () => {
    expect(
      NightlyPolicy.safeParse({
        reportableDefectClasses: ["leaked-credential", "disabled-tls-verification"],
        fixableDefectClasses: ["disabled-tls-verification"],
      }).success,
    ).toBe(true);
  });

  it("rejects a fixable class that is not reportable", () => {
    const result = NightlyPolicy.safeParse({
      reportableDefectClasses: ["leaked-credential"],
      fixableDefectClasses: ["disabled-tls-verification"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["fixableDefectClasses"]);
    }
  });
});

/** A schema-valid evidence manifest: source + CI required, LLM applicable. */
function validEvidence(): Record<string, unknown> {
  return {
    "source-analysis": { applicable: true, required: true },
    "release-risk-llm": { applicable: true, required: false },
    "candidate-ci": { applicable: true, required: true, requiredContexts: ["ci/build", "ci/test"] },
  };
}

describe("ReleasePolicy: stop and signoff disjoint", () => {
  it("accepts disjoint stop and signoff lists", () => {
    expect(
      ReleasePolicy.safeParse({
        stopDefectClasses: ["leaked-credential"],
        signoffDefectClasses: ["disabled-tls-verification"],
        evidence: validEvidence(),
      }).success,
    ).toBe(true);
  });

  it("rejects a class listed in both stop and signoff", () => {
    const result = ReleasePolicy.safeParse({
      stopDefectClasses: ["leaked-credential"],
      signoffDefectClasses: ["leaked-credential", "disabled-tls-verification"],
      evidence: validEvidence(),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["signoffDefectClasses"]);
    }
  });
});

describe("ReleasePolicy: service-owned evidence lanes", () => {
  const base = { stopDefectClasses: ["leaked-credential"], signoffDefectClasses: ["disabled-tls-verification"] };
  const withEvidence = (evidence: unknown) => ReleasePolicy.safeParse({ ...base, evidence });

  it("accepts a fully-declared evidence policy with required non-Scruffy CI contexts", () => {
    expect(withEvidence(validEvidence()).success).toBe(true);
  });

  it("rejects a policy with no evidence declaration at all (a missing lane must fail, not weaken)", () => {
    expect(ReleasePolicy.safeParse(base).success).toBe(false);
  });

  it("rejects unsafe release evidence policy", () => {
    // Malformed applicability: `applicable` is not a boolean.
    expect(
      withEvidence({
        ...validEvidence(),
        "source-analysis": { applicable: "yes", required: true },
      }).success,
    ).toBe(false);

    // Contradiction: a required lane that is not applicable.
    expect(
      withEvidence({
        ...validEvidence(),
        "release-risk-llm": { applicable: false, required: true },
      }).success,
    ).toBe(false);

    // An applicable candidate-CI lane with NO required contexts (trivially clean).
    expect(
      withEvidence({
        ...validEvidence(),
        "candidate-ci": { applicable: true, required: true, requiredContexts: [] },
      }).success,
    ).toBe(false);

    // Duplicate required CI contexts.
    expect(
      withEvidence({
        ...validEvidence(),
        "candidate-ci": { applicable: true, required: true, requiredContexts: ["ci/build", "ci/build"] },
      }).success,
    ).toBe(false);

    // A non-applicable candidate-CI lane that still names contexts (contradiction).
    expect(
      withEvidence({
        ...validEvidence(),
        "candidate-ci": { applicable: false, required: false, requiredContexts: ["ci/build"] },
      }).success,
    ).toBe(false);

    // An UNKNOWN lane id — `.strict()` rejects it rather than silently ignoring it.
    expect(withEvidence({ ...validEvidence(), "mystery-lane": { applicable: true, required: true } }).success).toBe(false);

    // A MISSING known lane — every lane must be declared explicitly.
    const missingCi = validEvidence();
    delete (missingCi as Record<string, unknown>)["candidate-ci"];
    expect(withEvidence(missingCi).success).toBe(false);

    // Candidate CI that names the gate's OWN `scruffy/release` context (self-dependency).
    expect(
      withEvidence({
        ...validEvidence(),
        "candidate-ci": { applicable: true, required: true, requiredContexts: ["scruffy/release"] },
      }).success,
    ).toBe(false);
  });
});
