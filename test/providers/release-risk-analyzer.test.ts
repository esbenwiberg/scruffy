import { describe, expect, it } from "vitest";
import {
  ModelReleaseRiskAnalyst,
  PROMPT_VERSION,
  MAX_ADDED_LINES_PER_CHUNK,
  MAX_CHUNKS,
  MAX_RISKS,
} from "../../src/providers/release-risk/model-release-risk.js";
import { FakeModelProvider } from "../../src/providers/models/fake.js";
import type { ModelProvider } from "../../src/providers/models/port.js";
import type { ChangedFile, RevisionRange } from "../../src/providers/scm/port.js";

/**
 * Range-level release-risk analyst.
 *
 * The four broken implementations this suite is built to catch, each of which
 * quietly turns the release gate green:
 *  - accepting a model-supplied path/line without anchoring it to a real change;
 *  - reviewing only a prefix of a large range and calling it complete;
 *  - swallowing a provider failure / malformed output as an empty (clean) result;
 *  - flooding past the risk cap without saying so.
 */

const RANGE: RevisionRange = {
  repository: "acme/web",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};

/** A new-file patch: added lines get new-file line numbers 1..N. */
function newFilePatch(lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

function file(path: string, lines: string[]): ChangedFile {
  return { path, patch: newFilePatch(lines) };
}

interface RawCitation {
  path: string;
  line: number;
}

function risk(category: string, citations: RawCitation[], over: Record<string, unknown> = {}) {
  return {
    category,
    scenario: "a plausible failure",
    affectedSurface: "the pricing path",
    blastRadius: "all invoices produced while the candidate is deployed",
    impact: "wrong charges",
    reversibility: "future calculations recover after rollback; issued invoices require correction",
    detectability: "invoice reconciliation and customer reports",
    rollback: "restore the prior pricing implementation and reconcile affected invoices",
    uncertainty: "production invoice volume is not visible in the diff",
    supportingEvidence: ["the changed line alters the pricing calculation"],
    contradictingEvidence: [],
    citations,
    ...over,
  };
}

function envelope(risks: unknown[], summary = "the range changes pricing"): string {
  return JSON.stringify({ summary, risks });
}

function fakeModel(text: string): ModelProvider {
  return new FakeModelProvider({ [PROMPT_VERSION]: text });
}

describe("ModelReleaseRiskAnalyst", () => {
  it("anchors release risks to real changed lines", async () => {
    const files = [
      file("src/pay.ts", [
        "const rate = 0.2;",
        "export const fee = rate * 100;",
        "export const tax = fee;",
      ]),
    ];
    // One risk cites a REAL added line; two cite fabrications (a ghost file and a
    // non-existent line in a real file). Only the real one may survive.
    const model = fakeModel(
      envelope([
        risk("data-integrity", [{ path: "src/pay.ts", line: 1 }]),
        risk("security-and-access", [{ path: "src/ghost.ts", line: 99 }]),
        risk("operations", [{ path: "src/pay.ts", line: 999 }]),
      ]),
    );

    const result = await new ModelReleaseRiskAnalyst(model).assess(RANGE, files);

    // The real cited risk is retained as model-asserted evidence.
    expect(result.risks).toHaveLength(1);
    expect(result.risks[0]!.category).toBe("data-integrity");
    expect(result.risks[0]!.blastRadius).toContain("all invoices");
    expect(result.risks[0]!.detectability).toContain("reconciliation");
    expect(result.risks[0]!.rollback).toContain("prior pricing");
    expect(result.risks[0]!.supportingEvidence).toHaveLength(1);
    expect(result.risks[0]!.citations).toEqual([{ path: "src/pay.ts", line: 1 }]);

    // The fabricated citations cannot enter the report as a risk — anywhere.
    const allCited = result.risks.flatMap((r) => r.citations.map((c) => `${c.path}:${c.line}`));
    expect(allCited).not.toContain("src/ghost.ts:99");
    expect(allCited).not.toContain("src/pay.ts:999");

    // A real risk survived, so this is complete coverage (no gap), not a suspicious empty set.
    expect(result.gaps).toEqual([]);
    expect(result.provenance.promptVersion).toBe(PROMPT_VERSION);
  });

  it("reports incomplete release-risk coverage", async () => {
    const files = [file("src/pay.ts", ["const rate = 0.2;", "export const fee = rate * 100;"])];

    // (a) Provider failure — never swallowed as an empty clean result.
    const throwing: ModelProvider = {
      id: "boom",
      async complete() {
        throw new Error("provider down");
      },
    };
    const failed = await new ModelReleaseRiskAnalyst(throwing).assess(RANGE, files);
    expect(failed.risks).toEqual([]);
    expect(failed.gaps.map((g) => g.code)).toContain("provider_unavailable");
    expect(failed.gaps.length).toBeGreaterThan(0); // NOT a complete empty risk list
    expect(failed.reviewedLines).toBe(0);

    // (b) Malformed output — reached the model, cannot use what it said.
    const malformed = await new ModelReleaseRiskAnalyst(fakeModel("I am not JSON at all")).assess(
      RANGE,
      files,
    );
    expect(malformed.risks).toEqual([]);
    expect(malformed.gaps.map((g) => g.code)).toContain("unparseable_output");

    // (c) Truncation — a range larger than MAX_CHUNKS*MAX_ADDED_LINES_PER_CHUNK is
    //     only partially reviewed; the remainder is an explicit gap, never a hidden
    //     prefix passed off as the whole range.
    const cap = MAX_ADDED_LINES_PER_CHUNK * MAX_CHUNKS;
    const big = Array.from({ length: cap + 25 }, (_, i) => `const v${i} = ${i};`);
    const truncated = await new ModelReleaseRiskAnalyst(fakeModel(envelope([]))).assess(RANGE, [
      file("src/big.ts", big),
    ]);
    expect(truncated.gaps.map((g) => g.code)).toContain("input_truncated");
    expect(truncated.reviewedLines).toBe(cap);
    expect(truncated.totalLines).toBe(cap + 25);

    // (d) Output cap — a model flood past MAX_RISKS is carried only up to the cap
    //     and the overflow is reported, never silently dropped.
    const count = MAX_RISKS + 5;
    const wide = Array.from({ length: count }, (_, i) => `const w${i} = ${i};`);
    const manyRisks = Array.from({ length: count }, (_, i) =>
      risk("operations", [{ path: "src/wide.ts", line: i + 1 }]),
    );
    const capped = await new ModelReleaseRiskAnalyst(fakeModel(envelope(manyRisks))).assess(RANGE, [
      file("src/wide.ts", wide),
    ]);
    expect(capped.risks).toHaveLength(MAX_RISKS);
    expect(capped.gaps.map((g) => g.code)).toContain("output_capped");
  });

  it("reviews interactions across the release range", async () => {
    // Related changes in SEPARATE files: a rate constant in one, its consumer in
    // another. The analyst can represent their interaction with both changes in
    // the risk's evidence.
    const files = [
      file("src/rate.ts", ["export const rate = 0.2;"]),
      file("src/invoice.ts", [
        "import { rate } from './rate';",
        "export const total = (n) => n * rate;",
      ]),
    ];
    const model = fakeModel(
      envelope([
        risk("cross-change-interaction", [
          { path: "src/rate.ts", line: 1 },
          { path: "src/invoice.ts", line: 2 },
        ]),
      ]),
    );

    const result = await new ModelReleaseRiskAnalyst(model).assess(RANGE, files);

    expect(result.risks).toHaveLength(1);
    expect(result.risks[0]!.category).toBe("cross-change-interaction");
    const cited = result.risks[0]!.citations.map((c) => `${c.path}:${c.line}`);
    expect(cited).toContain("src/rate.ts:1");
    expect(cited).toContain("src/invoice.ts:2");
    expect(result.gaps).toEqual([]);
  });

  it("allows a valid complete empty result", async () => {
    // The model saw the whole (small) range and asserted no risk. That is a real
    // answer — empty risks AND empty gaps, distinct from "could not look".
    const files = [file("src/clean.ts", ["export const add = (a, b) => a + b;"])];
    const result = await new ModelReleaseRiskAnalyst(fakeModel(envelope([]))).assess(RANGE, files);
    expect(result.risks).toEqual([]);
    expect(result.gaps).toEqual([]);
  });
});
