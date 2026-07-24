import { describe, expect, it } from "vitest";
import {
  POISON_BLOCKABLE_CLASSES,
  NIGHTLY_FIXABLE_CLASSES,
  RELEASE_STOP_CLASSES,
  RELEASE_SIGNOFF_CLASSES,
  defaultValidator,
  defaultFixers,
} from "../../src/providers/registry.js";
import type { Finding } from "../../src/domain/evidence/types.js";

/**
 * Guards the registry's single-source-of-truth invariants that used to live only
 * in comments and hand-matched string literals. The keyed-Record return types in
 * registry.ts enforce coverage at compile time; these tests enforce it at runtime
 * so a drift (a blockable class routed to no validator, a fixable class with no
 * fixer, or an overlap between the release stop/sign-off sets) fails loudly.
 */

// A minimally-shaped finding whose ruleId/snippet make the class's validator
// reach a DECISIVE outcome (`validated`), so we can distinguish "a validator is
// registered" from the CompositeValidator's "no validator → indeterminate" path.
function decisiveFinding(defectClass: string): Finding {
  const byClass: Record<string, { ruleId: string; path: string; snippet: string }> = {
    "leaked-credential": { ruleId: "SECRET.AWS", path: "src/config.ts", snippet: "" },
    "destructive-schema-change": { ruleId: "MIGRATION.TRUNCATE", path: "db/001.sql", snippet: "TRUNCATE users;" },
    "disabled-tls-verification": {
      ruleId: "TLS.REJECT_UNAUTHORIZED_FALSE",
      path: "src/client.ts",
      snippet: "rejectUnauthorized: false",
    },
  };
  const spec = byClass[defectClass] ?? { ruleId: "UNKNOWN.RULE", path: "src/x.ts", snippet: "" };
  return {
    ruleId: spec.ruleId,
    defectClass,
    subject: { repository: "acme/app", commitSha: "a".repeat(40) },
    primaryRegion: { path: spec.path, startLine: 1, endLine: 1, snippet: spec.snippet },
    provenance: { analyzerId: "test", analyzerVersion: "1.0.0", modelId: null, promptVersion: null },
    supporting: [],
    contradicting: [],
    completeness: { requiredEvidencePresent: true, contextTruncated: false },
    validation: "not_requested",
  };
}

describe("registry invariants", () => {
  it("every POISON_BLOCKABLE_CLASS routes to a registered validator (not the abstain path)", async () => {
    const validator = defaultValidator();
    for (const cls of POISON_BLOCKABLE_CLASSES) {
      const outcome = await validator.validate(decisiveFinding(cls));
      // `indeterminate` is exactly what CompositeValidator returns when no
      // validator is registered for a class — a registered validator given a
      // decisive input must not land there.
      expect(outcome, `no validator registered for blockable class "${cls}"`).not.toBe("indeterminate");
    }
  });

  it("an unregistered defect class abstains (negative control for the coverage check)", async () => {
    const outcome = await defaultValidator().validate(decisiveFinding("not-a-registered-class"));
    expect(outcome).toBe("indeterminate");
  });

  it("every NIGHTLY_FIXABLE_CLASS has a registered fixer", () => {
    const fixers = defaultFixers();
    for (const cls of NIGHTLY_FIXABLE_CLASSES) {
      expect(fixers[cls], `no fixer registered for fixable class "${cls}"`).toBeDefined();
    }
  });

  it("RELEASE_STOP_CLASSES and RELEASE_SIGNOFF_CLASSES are disjoint", () => {
    const overlap = RELEASE_STOP_CLASSES.filter((c) => (RELEASE_SIGNOFF_CLASSES as readonly string[]).includes(c));
    expect(overlap, `release stop/sign-off sets overlap on: ${overlap.join(", ")}`).toEqual([]);
  });
});
