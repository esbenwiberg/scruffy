import { z } from "zod";
import { CaseProvenance, ChangedFileInput } from "./types.js";

/**
 * Labeled corpus for the NIGHTLY gate. Where the poison corpus scores one
 * block/allow/indeterminate outcome per subject, a nightly case scores a whole
 * range: the per-finding dispositions (report | propose_fix | suppress) and
 * whether a fix PR was generated where one was expected.
 *
 * Same hard rule as the rest of the corpus: synthetic or sanitized, invented
 * identifiers, provenance recorded.
 */

export const NightlyDisposition = z.enum(["suppress", "report", "propose_fix"]);
export type NightlyDisposition = z.infer<typeof NightlyDisposition>;

/**
 * Ground truth for one finding the gate should reach over the range. Match key is
 * (defectClass, path); seeded cases should keep at most one expected finding per
 * pair.
 */
export const ExpectedFinding = z.object({
  defectClass: z.string().min(1),
  path: z.string().min(1),
  disposition: NightlyDisposition,
  /** For propose_fix: a fix PR should be generated for this finding. */
  fixExpected: z.boolean().optional(),
});
export type ExpectedFinding = z.infer<typeof ExpectedFinding>;

export const NightlyCase = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  range: z.object({
    repository: z.string().min(1),
    baseSha: z.string().nullable(),
    headSha: z.string().min(1),
  }),
  files: z.array(ChangedFileInput),
  /** Ground-truth findings the gate should surface/suppress. */
  expected: z.array(ExpectedFinding),
  /** Optional regression pin on the disposition summary counts. */
  expectedSummary: z
    .object({
      reported: z.number().int().nonnegative(),
      proposedFixes: z.number().int().nonnegative(),
      suppressed: z.number().int().nonnegative(),
    })
    .optional(),
  provenance: CaseProvenance,
});
export type NightlyCase = z.infer<typeof NightlyCase>;

export const NightlyCorpus = z.array(NightlyCase);
export type NightlyCorpus = z.infer<typeof NightlyCorpus>;
