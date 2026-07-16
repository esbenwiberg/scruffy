import { z } from "zod";
import { CaseProvenance, ChangedFileInput } from "./types.js";

/**
 * Labeled corpus for the RELEASE gate. Where the nightly corpus scores per-finding
 * dispositions over a range, a release case scores the ONE aggregate outcome the
 * gate reaches over the (prev-release, candidate] range — the release analog of
 * the poison corpus, which scores one outcome per subject.
 *
 * Same hard rule as the rest of the corpus: synthetic or sanitized, invented
 * identifiers, provenance recorded. This repo is public; never commit real
 * repo-derived content.
 */

/**
 * Ground-truth outcome a perfect gate should reach for the range. Deliberately
 * excludes `indeterminate`: indeterminate is an OPERATIONAL abstention (the
 * analysis machinery failed), never a property of the change itself, so it can
 * never be the "truth" of a range.
 */
export const ReleaseTruthOutcome = z.enum(["ship", "sign-off-required", "stop"]);
export type ReleaseTruthOutcome = z.infer<typeof ReleaseTruthOutcome>;

/** All four outcomes the gate can actually produce (regression pin + scoring). */
export const ReleaseActualOutcome = z.enum(["ship", "sign-off-required", "stop", "indeterminate"]);
export type ReleaseActualOutcome = z.infer<typeof ReleaseActualOutcome>;

export const ReleaseCase = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  range: z.object({
    repository: z.string().min(1),
    baseSha: z.string().nullable(),
    headSha: z.string().min(1),
  }),
  files: z.array(ChangedFileInput),
  /** What a perfect gate should decide for this range. */
  truthOutcome: ReleaseTruthOutcome,
  /**
   * Optional regression pin: the outcome we currently expect the skeleton to
   * produce. Distinct from truth — a legitimate sign-off on a range that ideally
   * could auto-ship is a safe, correct behavior even if it is not the ideal.
   */
  expectedOutcome: ReleaseActualOutcome.optional(),
  provenance: CaseProvenance,
});
export type ReleaseCase = z.infer<typeof ReleaseCase>;

export const ReleaseCorpus = z.array(ReleaseCase);
export type ReleaseCorpus = z.infer<typeof ReleaseCorpus>;
