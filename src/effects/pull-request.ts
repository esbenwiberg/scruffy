import { z } from "zod";
import { SubjectRevision } from "../domain/evidence/types.js";
import { PreconditionedEdit } from "../domain/fixes/delivery.js";
import { RemediationProvenance } from "../domain/findings/work-identity.js";
import type { PullRequestInput } from "../providers/scm/port.js";

/**
 * Outbox payload for a fix-PR effect. Persisted JSON is untrusted at the
 * boundary (heritage scar), so the dispatcher parses it through this schema
 * before performing the write.
 *
 * BACKWARD COMPATIBILITY. Rows enqueued before the delivery lifecycle existed
 * carry no `proposalId`, `draft`, or per-edit preimage. They must still dispatch
 * rather than dead-letter on a schema change, so those fields are optional here
 * and defaulted in `toPullRequestInput`. Everything nightly enqueues from now on
 * populates them (see `planFixDeliveryEffect`).
 */
export const PullRequestPayload = z.object({
  subject: SubjectRevision,
  externalId: z.string().min(1),
  branch: z.string().min(1),
  /** Merge target (the reviewed branch). Optional: pre-existing persisted
   * effects lack it; adapters fall back to the repo default branch. */
  baseBranch: z.string().min(1).optional(),
  /** Reviewed range base sha — identity, not the merge target. */
  baseSha: z.string().min(1).nullable().optional(),
  title: z.string().min(1),
  body: z.string().min(1),
  edits: z.array(PreconditionedEdit).min(1),
  /**
   * Fix proposal identity. Optional only for legacy rows; when present it is
   * what the adapter writes into the commit manifest and what the persisted
   * lifecycle row is keyed on.
   */
  proposalId: z.string().min(1).optional(),
  /** Work item whose child issue this PR remediates, for body/link reconciliation. */
  workItemId: z.string().min(1).optional(),
  /** The nightly run (parent) work item, so the PR body links the whole report. */
  parentWorkItemId: z.string().min(1).optional(),
  /** Open as a draft (structurally safe but semantically unconfirmed patch). */
  draft: z.boolean().optional(),
  provenance: RemediationProvenance.optional(),
});
export type PullRequestPayload = z.infer<typeof PullRequestPayload>;

export function toPullRequestInput(payload: PullRequestPayload): PullRequestInput {
  return {
    subject: payload.subject,
    externalId: payload.externalId,
    branch: payload.branch,
    ...(payload.baseBranch !== undefined ? { baseBranch: payload.baseBranch } : {}),
    ...(payload.baseSha !== undefined ? { baseSha: payload.baseSha } : {}),
    title: payload.title,
    body: payload.body,
    edits: payload.edits.map((e) => ({
      path: e.path,
      startLine: e.startLine,
      endLine: e.endLine,
      replacement: e.replacement,
      ...(e.expectedOriginal !== undefined ? { expectedOriginal: e.expectedOriginal } : {}),
    })),
    // A legacy row has no proposal identity; its externalId (the old branch name)
    // is the most specific stable token it has, so the manifest still names
    // something reproducible rather than nothing.
    proposalId: payload.proposalId ?? payload.externalId,
    // Absent means "not a draft": the old behaviour, preserved exactly.
    draft: payload.draft ?? false,
    ...(payload.provenance !== undefined ? { provenance: payload.provenance } : {}),
  };
}
