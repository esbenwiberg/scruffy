import type { Analyzer } from "../providers/analyzers/port.js";
import type { Validator } from "../domain/validation/port.js";
import type { Fixer } from "../providers/fixers/port.js";
import type { NightlyPolicy } from "../domain/policy/types.js";
import type { ScmReader } from "../providers/scm/port.js";
import { runNightlyAnalysis } from "../gates/nightly/analyze.js";
import { generateFixes } from "../gates/nightly/fix.js";
import type { NightlyCase, NightlyDisposition } from "./nightly-types.js";

/**
 * Replays a labeled nightly corpus through `runNightlyAnalysis` + `generateFixes`
 * and scores it — the nightly analog of `replayCorpus`. It measures whether the
 * gate reaches the RIGHT disposition per finding and generates a fix PR where one
 * is expected, and reports surface precision/recall so "the gate reported a lot"
 * can be told apart from "the gate reported the right things".
 *
 * Match key is (defectClass, path). A surfaced disposition is report|propose_fix;
 * suppress is not surfaced. A regression pin on the summary counts fails loudly.
 */

export interface NightlyCaseResult {
  id: string;
  correct: number; // expected findings the gate matched (disposition equal)
  wrongDisposition: number; // present at the location but wrong disposition
  missed: number; // expected surfaced finding the gate did not surface
  falseSurface: number; // gate surfaced something with no expected counterpart
  fixesExpected: number;
  fixesGenerated: number; // generated fixes matching an expected propose_fix
  summaryRegressed: boolean;
}

export interface NightlyReplayReport {
  total: number;
  totals: {
    expectedSurfaced: number;
    actualSurfaced: number;
    correct: number;
    wrongDisposition: number;
    missed: number;
    falseSurface: number;
    fixesExpected: number;
    fixesGenerated: number;
  };
  metrics: {
    surfacePrecision: number | null; // correct / actual surfaced
    surfaceRecall: number | null; // correct surfaced / expected surfaced
    dispositionAccuracy: number | null; // all correct (incl. suppress) / all expected
    fixGenerationRate: number | null; // fixes generated / fixes expected
  };
  regressions: { id: string; field: string; expected: string; actual: string }[];
  cases: NightlyCaseResult[];
}

export interface NightlyReplayDeps {
  analyzers: readonly Analyzer[];
  validator: Validator;
  fixers: Record<string, Fixer>;
  policy: NightlyPolicy;
}

const key = (defectClass: string, path: string): string => `${defectClass}::${path}`;

export async function replayNightlyCorpus(
  corpus: readonly NightlyCase[],
  deps: NightlyReplayDeps,
): Promise<NightlyReplayReport> {
  const cases: NightlyCaseResult[] = [];
  const regressions: NightlyReplayReport["regressions"] = [];
  const totals = {
    expectedSurfaced: 0,
    actualSurfaced: 0,
    correct: 0,
    wrongDisposition: 0,
    missed: 0,
    falseSurface: 0,
    fixesExpected: 0,
    fixesGenerated: 0,
  };

  for (const c of corpus) {
    const scm: ScmReader = {
      getChangedFiles: async () => c.files,
      getChangedFilesInRange: async () => c.files,
    };
    const analysis = await runNightlyAnalysis(c.range, {
      scm,
      analyzers: deps.analyzers,
      validator: deps.validator,
      policy: deps.policy,
    });
    const { decision, fixes } = generateFixes(analysis.findings, analysis.decision, deps.fixers);

    // Index the gate's dispositions by (defectClass, path). On collision keep the
    // most actionable so a co-located pair is not hidden behind a suppress.
    const rank: Record<NightlyDisposition, number> = { propose_fix: 0, report: 1, suppress: 2 };
    const actualByKey = new Map<string, NightlyDisposition>();
    for (const d of decision.dispositions) {
      const k = key(d.defectClass, d.region.path);
      const prev = actualByKey.get(k);
      if (prev === undefined || rank[d.disposition] < rank[prev]) actualByKey.set(k, d.disposition);
    }
    const actualSurfaced = decision.dispositions.filter((d) => d.disposition !== "suppress");
    const expectedKeys = new Set(c.expected.map((e) => key(e.defectClass, e.path)));

    const r: NightlyCaseResult = {
      id: c.id,
      correct: 0,
      wrongDisposition: 0,
      missed: 0,
      falseSurface: 0,
      fixesExpected: c.expected.filter((e) => e.disposition === "propose_fix" && e.fixExpected).length,
      fixesGenerated: 0,
      summaryRegressed: false,
    };

    for (const e of c.expected) {
      const actual = actualByKey.get(key(e.defectClass, e.path)) ?? "suppress";
      if (actual === e.disposition) r.correct += 1;
      else if (e.disposition !== "suppress" && actual === "suppress") r.missed += 1;
      else r.wrongDisposition += 1;
    }
    for (const a of actualSurfaced) {
      if (!expectedKeys.has(key(a.defectClass, a.region.path))) r.falseSurface += 1;
    }

    // Fix generation: an expected propose_fix+fixExpected is satisfied by a
    // generated fix for the same defect class at the same path.
    const fixKeys = new Set(fixes.map((f) => key(f.defectClass, f.edits[0]!.path)));
    for (const e of c.expected) {
      if (e.disposition === "propose_fix" && e.fixExpected && fixKeys.has(key(e.defectClass, e.path))) {
        r.fixesGenerated += 1;
      }
    }

    if (c.expectedSummary) {
      const got = decision.summary;
      if (
        got.reported !== c.expectedSummary.reported ||
        got.proposedFixes !== c.expectedSummary.proposedFixes ||
        got.suppressed !== c.expectedSummary.suppressed
      ) {
        r.summaryRegressed = true;
        regressions.push({
          id: c.id,
          field: "summary",
          expected: JSON.stringify(c.expectedSummary),
          actual: JSON.stringify(got),
        });
      }
    }

    totals.expectedSurfaced += c.expected.filter((e) => e.disposition !== "suppress").length;
    totals.actualSurfaced += actualSurfaced.length;
    totals.correct += r.correct;
    totals.wrongDisposition += r.wrongDisposition;
    totals.missed += r.missed;
    totals.falseSurface += r.falseSurface;
    totals.fixesExpected += r.fixesExpected;
    totals.fixesGenerated += r.fixesGenerated;
    cases.push(r);
  }

  // Surfaced findings the gate got right = everything it surfaced, minus the ones
  // with no expected counterpart (falseSurface) and the ones at an expected
  // location but with the wrong disposition (wrongDisposition).
  const surfacedMatched = totals.actualSurfaced - totals.falseSurface - totals.wrongDisposition;
  const expectedTotal = corpus.reduce((n, c) => n + c.expected.length, 0);

  const metrics = {
    surfacePrecision: totals.actualSurfaced === 0 ? null : surfacedMatched / totals.actualSurfaced,
    surfaceRecall: totals.expectedSurfaced === 0 ? null : surfacedMatched / totals.expectedSurfaced,
    dispositionAccuracy: expectedTotal === 0 ? null : totals.correct / expectedTotal,
    fixGenerationRate: totals.fixesExpected === 0 ? null : totals.fixesGenerated / totals.fixesExpected,
  };

  return { total: corpus.length, totals, metrics, regressions, cases };
}
