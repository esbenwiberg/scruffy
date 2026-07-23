import type { Analyzer } from "../providers/analyzers/port.js";
import type { Validator } from "../domain/validation/port.js";
import type { PoisonPolicy } from "../domain/policy/types.js";
import type { ScmReader } from "../providers/scm/port.js";
import { runPoisonAnalysis } from "../gates/poison/analyze.js";
import type { LabeledCase } from "./types.js";

/**
 * Replays a labeled corpus through the poison analysis + decision kernel and
 * scores the results. This is the measurement instrument the vision doc's
 * pre-registered thresholds require: block precision (with a Wilson lower
 * bound), false-block rate, severe-case recall, and abstain rate — broken down
 * by defect class.
 *
 * Abstention is treated as its own bucket, NOT as a false block: an
 * indeterminate outcome escalates to a deeper gate, it does not wrongly block a
 * clean change.
 */

export type Bucket =
  | "true_block" // poison, blocked (correct catch)
  | "false_block" // clean, blocked (the expensive error)
  | "missed" // poison, allowed (escaped the poison gate)
  | "true_allow" // clean, allowed (correct)
  | "abstain_on_poison" // poison, abstained (escalated, not caught here)
  | "abstain_on_clean"; // clean, abstained (over-cautious, but safe)

export interface CaseResult {
  id: string;
  defectClass: string | null;
  truthPoison: boolean;
  outcome: "block" | "allow" | "indeterminate";
  bucket: Bucket;
  expectedOutcome?: "block" | "allow" | "indeterminate";
  regressed: boolean;
}

export interface ReplayReport {
  total: number;
  positives: number;
  negatives: number;
  confusion: Record<Bucket, number>;
  metrics: {
    blockPrecision: number | null;
    blockPrecisionWilsonLower95: number | null;
    falseBlockRate: number | null;
    severeRecall: number | null;
    abstainRate: number;
  };
  byDefectClass: Record<string, { positives: number; caught: number; missed: number; abstained: number }>;
  regressions: { id: string; expected: string; actual: string }[];
  cases: CaseResult[];
}

export interface ReplayDeps {
  analyzers: readonly Analyzer[];
  validator: Validator;
  policy: PoisonPolicy;
}

function bucketFor(truthPoison: boolean, outcome: CaseResult["outcome"]): Bucket {
  if (outcome === "indeterminate") return truthPoison ? "abstain_on_poison" : "abstain_on_clean";
  if (outcome === "block") return truthPoison ? "true_block" : "false_block";
  return truthPoison ? "missed" : "true_allow";
}

/** Wilson score interval lower bound for a binomial proportion (95%, z=1.96). */
function wilsonLower95(successes: number, n: number): number | null {
  if (n === 0) return null;
  const z = 1.96;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

export async function replayCorpus(corpus: readonly LabeledCase[], deps: ReplayDeps): Promise<ReplayReport> {
  const cases: CaseResult[] = [];
  const confusion: Record<Bucket, number> = {
    true_block: 0,
    false_block: 0,
    missed: 0,
    true_allow: 0,
    abstain_on_poison: 0,
    abstain_on_clean: 0,
  };
  const byDefectClass: ReplayReport["byDefectClass"] = {};

  for (const c of corpus) {
    const scm: ScmReader = {
      getChangedFiles: async () => c.files,
      // Corpus replay scores the poison gate only; the range reader is never hit.
      getChangedFilesInRange: async () => {
        throw new Error("range read not supported in poison corpus replay");
      },
    };
    const { decision } = await runPoisonAnalysis(c.subject, {
      scm,
      analyzers: deps.analyzers,
      validator: deps.validator,
      policy: deps.policy,
    });

    const bucket = bucketFor(c.truthPoison, decision.outcome);
    confusion[bucket] += 1;

    const regressed = c.expectedOutcome !== undefined && c.expectedOutcome !== decision.outcome;
    cases.push({
      id: c.id,
      defectClass: c.truthDefectClass,
      truthPoison: c.truthPoison,
      outcome: decision.outcome,
      bucket,
      ...(c.expectedOutcome !== undefined ? { expectedOutcome: c.expectedOutcome } : {}),
      regressed,
    });

    if (c.truthPoison) {
      const cls = c.truthDefectClass ?? "unclassified";
      const entry = (byDefectClass[cls] ??= { positives: 0, caught: 0, missed: 0, abstained: 0 });
      entry.positives += 1;
      // Credit a catch to this class ONLY when the block was actually for this
      // class. A case blocked by an incidental finding of a DIFFERENT class is a
      // block, but it does not demonstrate recall for the labeled defect.
      const blockedForThisClass =
        decision.outcome === "block" && decision.dispositions.some((d) => d.effect === "blocks" && d.defectClass === cls);
      if (bucket === "true_block" && blockedForThisClass) entry.caught += 1;
      else if (bucket === "missed") entry.missed += 1;
      else if (bucket === "abstain_on_poison") entry.abstained += 1;
    }
  }

  const positives = confusion.true_block + confusion.missed + confusion.abstain_on_poison;
  const negatives = confusion.true_allow + confusion.false_block + confusion.abstain_on_clean;
  const decidedBlocks = confusion.true_block + confusion.false_block;
  const abstains = confusion.abstain_on_poison + confusion.abstain_on_clean;

  return {
    total: corpus.length,
    positives,
    negatives,
    confusion,
    metrics: {
      blockPrecision: decidedBlocks > 0 ? confusion.true_block / decidedBlocks : null,
      blockPrecisionWilsonLower95: wilsonLower95(confusion.true_block, decidedBlocks),
      falseBlockRate: negatives > 0 ? confusion.false_block / negatives : null,
      severeRecall: positives > 0 ? confusion.true_block / positives : null,
      abstainRate: corpus.length > 0 ? abstains / corpus.length : 0,
    },
    byDefectClass,
    regressions: cases.filter((c) => c.regressed).map((c) => ({ id: c.id, expected: c.expectedOutcome!, actual: c.outcome })),
    cases,
  };
}
