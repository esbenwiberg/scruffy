import { describe, expect, it } from "vitest";
import { replayNightlyCorpus, type NightlyReplayDeps } from "../../src/corpus/nightly-replay.js";
import type { NightlyCase } from "../../src/corpus/nightly-types.js";
import type { Analyzer } from "../../src/providers/analyzers/port.js";
import type { Validator } from "../../src/domain/validation/port.js";
import type { Finding } from "../../src/domain/evidence/types.js";
import type { NightlyPolicy } from "../../src/domain/policy/types.js";

/**
 * Regression guard for the (defectClass, path) match key. A delimiter-join keyed
 * scoring — `${defectClass}::${path}` — aliases distinct findings: defectClass
 * "x" at path "a::b" collapses onto defectClass "x::a" at path "b". The JSON-array
 * key (domain/findings/identity.ts convention) keeps them distinct.
 *
 * The two findings below collide under a "::"-join but disagree on disposition,
 * so a colliding key would mis-count (correct=1, wrongDisposition=1); the correct
 * key scores both cleanly (correct=2, nothing wrong).
 */

const SHA = "a".repeat(40);

function makeFinding(defectClass: string, path: string): Finding {
  return {
    ruleId: `rule-${defectClass}`,
    defectClass,
    subject: { repository: "octo/repo", commitSha: SHA },
    primaryRegion: { path, startLine: 1, endLine: 1, snippet: "x" },
    provenance: { analyzerId: "fake", analyzerVersion: "1", modelId: null, promptVersion: null },
    supporting: [],
    contradicting: [],
    completeness: { requiredEvidencePresent: true, contextTruncated: false },
    validation: "pending",
  };
}

// Emits two findings whose (defectClass, path) pairs alias under a "::"-join.
const collidingAnalyzer: Analyzer = {
  id: "colliding",
  analyze: async () => [makeFinding("x", "a::b"), makeFinding("x::a", "b")],
};

// Leaves validation as-emitted so classification is driven purely by policy.
const passthroughValidator: Validator = {
  id: "passthrough",
  validate: async (finding) => finding.validation,
};

// Only "x" is reportable, so "x::a" must suppress. Under a colliding key the two
// dispositions would merge to the most-actionable ("report") and the suppress
// expectation would be scored as a wrong disposition.
const POLICY: NightlyPolicy = { reportableDefectClasses: ["x"], fixableDefectClasses: [] };

const deps: NightlyReplayDeps = {
  analyzers: [collidingAnalyzer],
  validator: passthroughValidator,
  fixers: {},
  policy: POLICY,
};

const CASE: NightlyCase = {
  id: "colliding-keys",
  description: "two findings that alias under a ::-join but must score independently",
  range: { repository: "octo/repo", baseSha: null, headSha: SHA },
  files: [{ path: "a::b", patch: "" }],
  expected: [
    { defectClass: "x", path: "a::b", disposition: "report" },
    { defectClass: "x::a", path: "b", disposition: "suppress" },
  ],
  provenance: { source: "synthetic", author: "test", createdAt: "2026-07-24" },
};

describe("nightly replay match key (delimiter aliasing)", () => {
  it("scores a finding at a '::' path against its own counterpart, not a colliding one", async () => {
    const r = await replayNightlyCorpus([CASE], deps);
    const c = r.cases.find((x) => x.id === "colliding-keys")!;

    // Both expectations match their true counterpart; a ::-join would give
    // correct=1 / wrongDisposition=1 by merging the two keys.
    expect(c.correct).toBe(2);
    expect(c.wrongDisposition).toBe(0);
    expect(c.missed).toBe(0);
    expect(c.falseSurface).toBe(0);
  });
});
