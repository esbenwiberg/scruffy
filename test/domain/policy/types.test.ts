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

describe("ReleasePolicy: stop and signoff disjoint", () => {
  it("accepts disjoint stop and signoff lists", () => {
    expect(
      ReleasePolicy.safeParse({
        stopDefectClasses: ["leaked-credential"],
        signoffDefectClasses: ["disabled-tls-verification"],
      }).success,
    ).toBe(true);
  });

  it("rejects a class listed in both stop and signoff", () => {
    const result = ReleasePolicy.safeParse({
      stopDefectClasses: ["leaked-credential"],
      signoffDefectClasses: ["leaked-credential", "disabled-tls-verification"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["signoffDefectClasses"]);
    }
  });
});
