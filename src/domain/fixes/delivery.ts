import { z } from "zod";
import { ProposedEdit } from "./types.js";
import type { NightlyReportIdentity, RemediationProvenance } from "../findings/work-identity.js";

/**
 * Delivery identity for a fix proposal: how one proposal becomes exactly one
 * branch, one SCM idempotency key, one commit, and one PR body.
 *
 * WHY THIS EXISTS. The previous branch derivation was
 * `scruffy/fix/<defectClass>/<path-slug>-<pathHash>-L<line>` — a name built from
 * *where* a defect is rather than *which review found it*. Two things follow from
 * that, both bad:
 *
 *  1. The branch is not candidate-bound. Tonight's finding at `src/a.ts:42`
 *     derives the same branch as last month's finding at `src/a.ts:42`, so the
 *     old (possibly human-closed) PR is mistaken for delivery of the new
 *     proposal and a live defect looks handled. That is the regression the
 *     `recurring-location-opens-new-candidate-pr` scenario pins down.
 *  2. It is lossy about the fixer. A deterministic fixer and a model fixer
 *     proposing at the same location collide on one branch.
 *
 * The fix is to derive both the branch and the SCM idempotency key from the FULL
 * fix proposal identity (`fixProposalId`), which transitively binds repository,
 * branch, base sha, candidate head sha, policy version, report schema version,
 * the normalized finding key (which itself carries defect class, rule id and
 * location) and the fixer/model/prompt/proposal-schema versions. The human-
 * readable defect class and short candidate sha are kept as a PREFIX for
 * legibility only; the proposal id suffix is what makes the name unique.
 */

/** Version of the delivery shape (branch/commit/body rendering). */
export const FIX_DELIVERY_SCHEMA_VERSION = "fix-delivery-1";

/**
 * Git trailer key carrying the proposal id in the fix commit message.
 *
 * THE MANIFEST. A branch existing, or having advanced past the reviewed sha, is
 * NOT proof Scruffy's expected patch landed — a human, another tool, or a
 * half-finished older attempt could have moved it. The trailer is the crash-safe
 * manifest: the branch head commit either declares the exact proposal id it
 * delivered, or the writer refuses to treat it as delivered.
 */
export const FIX_COMMIT_TRAILER = "Scruffy-Fix-Proposal";

/** Trailer carrying the reviewed candidate sha the patch was anchored against. */
export const FIX_COMMIT_SUBJECT_TRAILER = "Scruffy-Reviewed-Sha";

/**
 * One edit as the delivery path applies it: a service-anchored line range plus,
 * when the source of the edit could supply one, the EXACT original text that
 * range must contain at the reviewed sha.
 *
 * `expectedOriginal` is optional because the two producers differ in what they
 * can honestly assert. A model proposal always carries a preimage (it is the
 * only thing that makes untrusted output anchorable — see
 * `proposal-validation.ts`). A deterministic fixer is pure code over a finding's
 * region and never reads file content, so it has no original text to claim;
 * forging one would be a lie dressed as a safety check. Both are still bound to
 * the reviewed candidate, because the writer commits with the reviewed sha as
 * the parent and reads the preimage material at that sha.
 */
export const PreconditionedEdit = ProposedEdit.extend({
  expectedOriginal: z.string().optional(),
});
export type PreconditionedEdit = z.infer<typeof PreconditionedEdit>;

/** Result of the writer's decision about whether a proposal is confirmed. */
export const FixDeliveryReadiness = z.enum(["ready", "draft"]);
export type FixDeliveryReadiness = z.infer<typeof FixDeliveryReadiness>;

const SLUG_MAX = 40;

/** Lowercase, ref-safe slug. Empty input degrades to `unknown`, never to "". */
function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return cleaned.length === 0 ? "unknown" : cleaned;
}

export interface FixBranchInput {
  /** `fixProposalId(...)` — the full proposal identity. */
  proposalId: string;
  /** Human-readable prefix only; identity comes from `proposalId`. */
  defectClass: string;
  /** The reviewed candidate head sha, for legibility in the branch name. */
  headSha: string;
}

/**
 * Candidate-bound head branch for a fix proposal.
 *
 * Shape: `scruffy/fix/<defect-class>/<head-sha-12>/<proposal-id>`. Every
 * component after the prefix is derived, so two proposals are equal here only if
 * their full identities are equal. The proposal id is included verbatim
 * (prefix stripped) rather than re-hashed, so a branch name can be traced back
 * to a stored proposal row by string match.
 */
export function fixProposalBranch(input: FixBranchInput): string {
  if (input.proposalId.length === 0) throw new Error("fixProposalBranch: proposalId is required");
  if (!/^[0-9a-f]{40}$/.test(input.headSha)) {
    throw new Error(`fixProposalBranch: headSha '${input.headSha}' is not a full 40-char sha`);
  }
  const id = input.proposalId.startsWith("nfp_") ? input.proposalId.slice("nfp_".length) : input.proposalId;
  return `scruffy/fix/${slug(input.defectClass)}/${input.headSha.slice(0, 12)}/${slug(id)}`;
}

/**
 * SCM idempotency key for delivering a proposal. Distinct namespace from the
 * branch so a future provider that cannot use branch names as keys (or a
 * provider whose branch names are normalized) still keys on the identity.
 */
export function fixProposalExternalId(proposalId: string): string {
  if (proposalId.length === 0) throw new Error("fixProposalExternalId: proposalId is required");
  return `nightly-fix-pr:${proposalId}`;
}

/** The fix commit message, carrying the manifest trailers. */
export function fixCommitMessage(input: { title: string; proposalId: string; reviewedSha: string }): string {
  return [
    input.title,
    "",
    `${FIX_COMMIT_TRAILER}: ${input.proposalId}`,
    `${FIX_COMMIT_SUBJECT_TRAILER}: ${input.reviewedSha}`,
  ].join("\n");
}

/**
 * Does `message` declare that it delivered exactly `proposalId`?
 *
 * Matched on a whole trailer line so `nfp_abc` cannot satisfy a lookup for
 * `nfp_abcdef`. This is the ONLY sanctioned way to conclude "the expected patch
 * is already on this branch".
 */
export function commitCarriesProposal(message: string, proposalId: string): boolean {
  const wanted = `${FIX_COMMIT_TRAILER}: ${proposalId}`;
  return message.split("\n").some((line) => line.trim() === wanted);
}

/**
 * The "which work items is this PR about" block, or null when neither issue is
 * known yet. Shared by the plan-time renderer and the dispatcher so the PR body a
 * human reads has ONE format regardless of when the references became available.
 */
export function fixWorkItemsSection(
  childIssue: { number: number; url: string } | null,
  parentIssue: { number: number; url: string } | null,
): string | null {
  if (childIssue === null && parentIssue === null) return null;
  const lines = ["## Work items"];
  if (childIssue !== null) lines.push(`- Finding issue: #${childIssue.number} (${childIssue.url})`);
  if (parentIssue !== null) lines.push(`- Nightly run issue: #${parentIssue.number} (${parentIssue.url})`);
  return lines.join("\n");
}

export interface FixPullRequestBodyInput {
  report: NightlyReportIdentity;
  reportId: string;
  proposalId: string;
  occurrenceId: string;
  defectClass: string;
  ruleId: string;
  provenance: RemediationProvenance;
  readiness: FixDeliveryReadiness;
  /** Stable reason code from the remediation attempt (critic verdict etc). */
  validationState: string;
  /** Free-form validation detail; may be empty. */
  validationDetail?: string;
  /** The child work item's published issue, when it is already known. */
  childIssue: { number: number; url: string } | null;
  /** The parent (nightly run) work item's published issue, when known. */
  parentIssue: { number: number; url: string } | null;
  edits: readonly PreconditionedEdit[];
  findingSummary: string;
}

/**
 * PR body for a fix proposal. Deliberately verbose about identity: a human
 * reviewing this must be able to tell WHICH review produced it, WHICH candidate
 * it was anchored to, WHO/WHAT wrote the patch, and that Scruffy will not merge
 * it. A draft says why it is a draft in the first line, not in a footnote.
 */
export function renderFixPullRequestBody(input: FixPullRequestBodyInput): string {
  const lines: string[] = [];

  if (input.readiness === "draft") {
    lines.push(
      "> **Draft — unconfirmed remediation.** This patch is structurally safe " +
        "(paths, preimages and policy limits all check out) but its semantic " +
        "correctness is NOT confirmed. Review it as a suggestion, not a fix.",
      "",
    );
  }

  lines.push(
    `Proposed remediation for a nightly finding (\`${input.defectClass}\` / \`${input.ruleId}\`).`,
    "",
    input.findingSummary,
  );

  // At PLAN time neither issue exists yet (the PR effect waits on the child issue
  // reference before it is even claimed), so the section is appended by the
  // dispatcher from durable references instead of guessed at here. Rendering
  // "not yet published" into an immutable PR body would leave a permanent lie in
  // the PR of every successfully published finding.
  const links = fixWorkItemsSection(input.childIssue, input.parentIssue);
  if (links !== null) lines.push("", links);

  lines.push(
    "",
    "## Reviewed candidate",
    `- Repository: \`${input.report.repository}\``,
    `- Branch: \`${input.report.branch}\``,
    `- Base: \`${input.report.baseSha ?? "(first review)"}\``,
    `- Reviewed head: \`${input.report.headSha}\``,
    `- Policy version: \`${input.report.policyVersion}\``,
    "",
    "## Identity",
    `- Report: \`${input.reportId}\``,
    `- Finding occurrence: \`${input.occurrenceId}\``,
    `- Fix proposal: \`${input.proposalId}\``,
    "",
    "## Remediation provenance",
    `- Source: \`${input.provenance.fixerKind}\` (\`${input.provenance.fixerId}\` v\`${input.provenance.fixerVersion}\`)`,
    `- Model: \`${input.provenance.modelId ?? "none"}\``,
    `- Prompt version: \`${input.provenance.promptVersion ?? "none"}\``,
    `- Proposal schema: \`${input.provenance.proposalSchemaVersion}\``,
    `- Validation: \`${input.validationState}\`${input.validationDetail ? ` — ${input.validationDetail}` : ""}`,
    "",
    "## Edits",
  );
  for (const edit of input.edits) {
    lines.push(
      `- \`${edit.path}\` lines ${edit.startLine}-${edit.endLine}` +
        `${edit.expectedOriginal === undefined ? "" : " (preimage-anchored)"} — ${edit.rationale}`,
    );
  }

  lines.push(
    "",
    "---",
    "Scruffy does **not** merge this pull request and does not change branch " +
      "protection. Repository CI runs on it as supporting evidence only; a green " +
      "run is not proof the finding is fixed. Merging, closing, and dismissing " +
      "are human decisions, and the finding issue stays open until Scruffy " +
      "verifies the merged result against the post-merge head.",
  );

  return lines.join("\n");
}
