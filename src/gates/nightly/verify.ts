import type { FindingVerification } from "../../domain/fixes/lifecycle.js";
import type { FixDeliveryRecord } from "../../persistence/fix-lifecycle.js";
import type { ScmReader } from "../../providers/scm/port.js";

/**
 * POST-MERGE VERIFICATION.
 *
 * A merge is not a fix. Before a finding may be resolved, something has to look at
 * the immutable candidate the merge produced and answer a finding-specific
 * question. Three answers are possible and all three are load-bearing:
 *
 *  - `resolved`     — the defect is demonstrably gone at this sha;
 *  - `still_present` — the patch merged and the defect is still there;
 *  - `indeterminate` — we could not tell.
 *
 * `indeterminate` is NOT rounded to either neighbour. "The file could not be read"
 * and "the defect is gone" are different facts, and only one of them is allowed to
 * close a human's work item. An indeterminate verification keeps the child (and
 * therefore the parent) open, which is the pessimistic direction — the only
 * direction it is safe to be wrong in.
 *
 * The verifier NEVER runs repository-controlled commands. It reads content at an
 * immutable sha through the read port and reasons about the proposal's own edits.
 */
export interface PostMergeVerificationInput {
  repository: string;
  /** The immutable post-merge branch head. Never a symbolic ref. */
  subjectSha: string;
  record: FixDeliveryRecord;
}

export interface PostMergeVerifier {
  readonly id: string;
  verify(input: PostMergeVerificationInput): Promise<FindingVerification>;
}

const VERIFIER_ID = "patch-applied-verifier-1";

/**
 * Deterministic verifier: did the proposal's own edits actually land, and is the
 * preimage they were supposed to replace gone?
 *
 * Scope, stated honestly: this proves the PATCH IS PRESENT at the post-merge head,
 * not that the underlying defect class is semantically eliminated. That is a real
 * limit, and it is why every uncertain case degrades to `indeterminate` instead of
 * claiming more than it checked:
 *
 *  - an unreadable path (missing, binary, oversized, provider fault) is
 *    indeterminate, never "resolved because we saw no defect";
 *  - an edit whose preimage is still present is `still_present` — the merge did not
 *    deliver this patch, whatever the PR said;
 *  - an edit with no preimage to check and no distinctive replacement to find is
 *    indeterminate, because absence of a signal is not a signal.
 */
export class PatchAppliedVerifier implements PostMergeVerifier {
  readonly id = VERIFIER_ID;

  constructor(private readonly scm: ScmReader) {}

  async verify(input: PostMergeVerificationInput): Promise<FindingVerification> {
    const subject = { repository: input.repository, commitSha: input.subjectSha };
    const details: string[] = [];
    let indeterminate = false;

    for (const edit of input.record.edits) {
      const content = await this.scm.getFileContent(subject, edit.path);
      if (!content.complete) {
        // A path the patch deleted reads as `not_found`, which is a legitimate
        // outcome of some fixes — but we cannot tell that from a path that was never
        // readable, so both stay indeterminate rather than guessing generously.
        indeterminate = true;
        details.push(`${edit.path}: could not read at ${input.subjectSha} (${content.reason})`);
        continue;
      }

      const preimagePresent = edit.expectedOriginal !== undefined && content.content.includes(edit.expectedOriginal);
      if (preimagePresent) {
        return {
          outcome: "still_present",
          detail: `${edit.path}: the reviewed original text is still present at ${input.subjectSha}`,
          subjectSha: input.subjectSha,
          verifierId: this.id,
        };
      }

      const replacement = edit.replacement.trim();
      if (replacement.length > 0 && content.content.includes(edit.replacement)) {
        details.push(`${edit.path}: patched text present`);
        continue;
      }
      if (edit.expectedOriginal !== undefined) {
        // Preimage gone even though the replacement is not literally findable (a
        // deletion, or a human reworking the patch before merging). The thing the
        // finding pointed at is no longer there, which is what was asked.
        details.push(`${edit.path}: reviewed original text no longer present`);
        continue;
      }
      indeterminate = true;
      details.push(`${edit.path}: no preimage to check and the replacement was not found`);
    }

    if (input.record.edits.length === 0) {
      return {
        outcome: "indeterminate",
        detail: "the proposal recorded no edits, so there is nothing to verify",
        subjectSha: input.subjectSha,
        verifierId: this.id,
      };
    }

    return {
      outcome: indeterminate ? "indeterminate" : "resolved",
      detail: details.join("; "),
      subjectSha: input.subjectSha,
      verifierId: this.id,
    };
  }
}
