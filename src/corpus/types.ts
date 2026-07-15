import { z } from "zod";
import { SubjectRevision } from "../domain/evidence/types.js";

/**
 * Labeled evaluation corpus. A corpus is a set of cases with GROUND-TRUTH labels
 * so the poison gate's decisions can be scored against reality — the only way to
 * turn "the validator culled 92% of candidates" into an actual precision/recall
 * (heritage assessment: "a cull rate is not a false-positive rate").
 *
 * HARD RULE: corpus data is synthetic or sanitized. The real PR Guardian audit
 * corpus contains personal and internal information and must NOT be copied here.
 * Every case records its provenance so that origin is auditable.
 */

export const CaseProvenance = z.object({
  source: z.enum(["synthetic", "seeded-mutation", "sanitized-historical"]),
  author: z.string().min(1),
  /** ISO date; passed in, never read from the ambient clock. */
  createdAt: z.string().min(1),
});
export type CaseProvenance = z.infer<typeof CaseProvenance>;

export const ChangedFileInput = z.object({
  path: z.string().min(1),
  patch: z.string(),
});

export const LabeledCase = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  subject: SubjectRevision,
  files: z.array(ChangedFileInput),
  /** Ground truth: is this change genuinely poison-worthy? */
  truthPoison: z.boolean(),
  /** Ground-truth defect class when truthPoison is true, else null. */
  truthDefectClass: z.string().nullable(),
  /**
   * Optional regression pin: the outcome we currently expect the gate to
   * produce (allow | block | indeterminate). Distinct from truth — a legitimate
   * abstain on a poison case is a correct behavior even though it is not a catch.
   */
  expectedOutcome: z.enum(["allow", "block", "indeterminate"]).optional(),
  provenance: CaseProvenance,
});
export type LabeledCase = z.infer<typeof LabeledCase>;

export const Corpus = z.array(LabeledCase);
export type Corpus = z.infer<typeof Corpus>;
