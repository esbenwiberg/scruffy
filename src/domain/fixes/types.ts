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
