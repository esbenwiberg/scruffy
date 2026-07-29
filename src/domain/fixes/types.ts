import { z } from "zod";
import { SubjectRevision } from "../evidence/types.js";

/**
 * A proposed remediation for a finding. Nightly generates these as PROPOSALS —
 * narrow patches opened as pull requests and validated by the repository's own
 * CI, never auto-merged (three-gate dossier / ADR 0003). A proposal is untrusted
 * output at the persistence and effect boundary, so it is schema-parsed like any
 * other evidence.
 */

/**
 * A single line-scoped edit. The skeleton fixers are deterministic and operate
 * on one offending line, so an edit replaces an inclusive line range with new
 * text. Real multi-hunk patch construction is a later concern.
 */
export const ProposedEdit = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  /** Replacement text for [startLine, endLine]. */
  replacement: z.string(),
  /** Why this edit is safe — surfaced in the PR body for the human reviewer. */
  rationale: z.string().min(1),
});
export type ProposedEdit = z.infer<typeof ProposedEdit>;

export const ProposedFix = z.object({
  subject: SubjectRevision,
  /**
   * Normalized identity of the finding this fix remediates (see
   * `domain/findings/identity.ts`). Carried so a proposal can be bound to its
   * finding occurrence EXACTLY — (defectClass, path) is lossy, and a proposal
   * attributed to the wrong finding would close the wrong piece of work.
   */
  findingKey: z.string().min(1),
  /** Defect class and rule this fix remediates, for provenance in the PR. */
  defectClass: z.string().min(1),
  ruleId: z.string().min(1),
  /** Deterministic head branch name; also the idempotency key for the PR. */
  branch: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  edits: z.array(ProposedEdit).min(1),
});
export type ProposedFix = z.infer<typeof ProposedFix>;

/**
 * One edit as an LLM remediation proposal states it — UNTRUSTED, schema-parsed
 * model output, never applied directly. Unlike `ProposedEdit` (a service-trusted,
 * already-anchored edit), a model edit anchors itself to source content the
 * validator must independently confirm:
 *
 *  - `expectedOriginal` is the exact text the model claims occupies the edit
 *    location. This is what proposal-validation matches against real subject
 *    content — a mismatch (missing or ambiguous) is a hallucination signal, not
 *    a patch to trust.
 *  - `startLine`/`endLine` are an OPTIONAL hint. When given, the match must be
 *    exact at that range. When absent, the validator locates the unique
 *    occurrence of `expectedOriginal` in the file — zero or multiple matches
 *    both reject the edit rather than guess.
 *  - `uncertain` is the model's own declared doubt about this specific edit,
 *    carried through to classification; it can only ever narrow eligibility
 *    (push toward draft), never widen it.
 */
export const ModelProposedEdit = z
  .object({
    path: z.string().min(1),
    expectedOriginal: z.string().min(1),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    replacement: z.string(),
    rationale: z.string().min(1),
    uncertain: z.boolean().optional(),
  })
  .superRefine((edit, ctx) => {
    if ((edit.startLine === undefined) !== (edit.endLine === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endLine"],
        message: "startLine and endLine must both be present or both be absent",
      });
      return;
    }
    if (edit.startLine !== undefined && edit.endLine !== undefined && edit.endLine < edit.startLine) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endLine"], message: "endLine must be >= startLine" });
    }
  });
export type ModelProposedEdit = z.infer<typeof ModelProposedEdit>;

/**
 * The full structured output of the LLM remediation prompt — one or more bounded
 * edits, never a free-form patch. Bounded to `min(1)`: an empty array is not a
 * coherent proposal, it is "no fix" and must be represented as remediation
 * unavailable, not as a zero-edit proposal that then vacuously validates.
 */
export const ModelFixProposal = z.object({
  edits: z.array(ModelProposedEdit).min(1),
});
export type ModelFixProposal = z.infer<typeof ModelFixProposal>;
