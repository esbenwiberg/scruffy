import { z } from "zod";
import { FindingResolution, ProposalCiState, ProposalDelivery, ProposalMergeState } from "../findings/work-graph.js";

/**
 * Derivation rules for the fix-delivery lifecycle: repository CI evidence, human
 * merge/close actions, post-merge verification, and when a parent nightly work
 * item may finally close.
 *
 * Everything here is PURE. The reconciler does the IO (read the PR, read checks,
 * read the branch head, run a verifier) and then asks these functions what the
 * durable state should be, so every rule the brief cares about is testable
 * without a provider or a database:
 *
 *  - CI evidence is only ever current for the sha it was read at. A green run on
 *    an earlier head says nothing about the head a human is now looking at, so
 *    `ciStateForHead` refuses to reuse it rather than quietly reporting `passed`.
 *  - A merge is NOT a resolution. It moves the finding to `awaiting_verification`
 *    and nothing else.
 *  - Verification must be conclusive to resolve. Missing, indeterminate, and
 *    "still present" all keep the child non-terminal, which keeps the parent open.
 *  - A human closing the issue is recorded as an external DISMISSAL with whatever
 *    actor/reason the provider gave us. It is never relabeled as verified.
 */

const Sha40 = z.string().regex(/^[0-9a-f]{40}$/, "must be a full 40-char sha");

// ── Repository CI evidence (SHA-bound) ──────────────────────────────────────

/** A check run as the provider reports it for one commit. */
export const CheckRunEvidence = z.object({
  name: z.string().min(1),
  status: z.enum(["queued", "in_progress", "completed"]),
  /** Null while the run has not completed. */
  conclusion: z.string().nullable(),
});
export type CheckRunEvidence = z.infer<typeof CheckRunEvidence>;

/** A legacy combined-status context as the provider reports it for one commit. */
export const CommitStatusEvidence = z.object({
  context: z.string().min(1),
  state: z.enum(["error", "failure", "pending", "success"]),
});
export type CommitStatusEvidence = z.infer<typeof CommitStatusEvidence>;

/**
 * All CI evidence read for ONE immutable commit. `sha` is not decoration: it is
 * the whole safety mechanism. Both surfaces are read because repositories use
 * either or both — a repo on legacy statuses would look like "no CI at all" if we
 * only read check runs, and vice versa.
 */
export const CiEvidence = z.object({
  sha: Sha40,
  checkRuns: z.array(CheckRunEvidence),
  statuses: z.array(CommitStatusEvidence),
});
export type CiEvidence = z.infer<typeof CiEvidence>;

/** Check-run conclusions that mean "this did not pass". */
const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);

/** Check-run conclusions that mean "this did not block". */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * Fold one commit's evidence into a CI verdict.
 *
 * FAILURE WINS OVER PENDING. A PR with one failed job and one still running is
 * not "pending, might yet be fine" — it already has a failing signal, and the
 * only direction we are allowed to be wrong in is the pessimistic one. `unknown`
 * (no evidence at all) is kept distinct from `pending`: "the repository posted
 * nothing" and "the repository is still working" are different facts, and only
 * the first one might mean the repository has no CI.
 *
 * An unrecognised conclusion string is treated as failing, not ignored: GitHub
 * can add conclusions, and a conclusion we cannot classify must never silently
 * count towards green.
 */
export function deriveCiState(evidence: CiEvidence): ProposalCiState {
  if (evidence.checkRuns.length === 0 && evidence.statuses.length === 0) return "unknown";

  let pending = false;
  for (const run of evidence.checkRuns) {
    if (run.status !== "completed" || run.conclusion === null) {
      pending = true;
      continue;
    }
    if (FAILING_CONCLUSIONS.has(run.conclusion)) return "failed";
    if (!PASSING_CONCLUSIONS.has(run.conclusion)) return "failed";
  }
  for (const status of evidence.statuses) {
    if (status.state === "error" || status.state === "failure") return "failed";
    if (status.state === "pending") pending = true;
  }
  return pending ? "pending" : "passed";
}

export interface HeadBoundCi {
  state: ProposalCiState;
  /** The sha the recorded verdict belongs to, or null when nothing applies. */
  evidenceSha: string | null;
  /** True when evidence was supplied but for a different head than asked about. */
  stale: boolean;
}

/**
 * CI state for `headSha`, and only for `headSha`.
 *
 * This is the `latest-head-ci-only` rule in one function: if the evidence was
 * read at another commit, the answer is `unknown` with `stale: true`. It is not
 * `passed` because it was green there, and it is not silently dropped either —
 * the caller records that the verdict for the CURRENT head is not yet known, so
 * an updated proposal can never inherit the previous head's green run.
 */
export function ciStateForHead(headSha: string, evidence: CiEvidence | null): HeadBoundCi {
  if (evidence === null) return { state: "unknown", evidenceSha: null, stale: false };
  if (evidence.sha !== headSha) return { state: "unknown", evidenceSha: null, stale: true };
  return { state: deriveCiState(evidence), evidenceSha: evidence.sha, stale: false };
}

// ── Observed provider state ─────────────────────────────────────────────────

/** The PR as the provider currently reports it. */
export const PullRequestObservation = z.object({
  number: z.number().int().positive(),
  url: z.string().min(1),
  /** IMMUTABLE head sha of the PR right now. CI is only ever bound to this. */
  headSha: Sha40,
  draft: z.boolean(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  mergeCommitSha: Sha40.nullable(),
});
export type PullRequestObservation = z.infer<typeof PullRequestObservation>;

/** Merge state derived from an observation. `merged` is terminal. */
export function deriveMergeState(observation: PullRequestObservation): ProposalMergeState {
  if (observation.merged) return "merged";
  return observation.state === "closed" ? "closed_unmerged" : "open";
}

/** Delivery state derived from an observation — draft vs ready is provider truth. */
export function deriveDeliveryState(observation: PullRequestObservation): ProposalDelivery {
  return observation.draft ? "draft_open" : "ready_open";
}

// ── Post-merge verification ─────────────────────────────────────────────────

export const VERIFICATION_OUTCOMES = ["resolved", "still_present", "indeterminate"] as const;
export const VerificationOutcome = z.enum(VERIFICATION_OUTCOMES);
export type VerificationOutcome = z.infer<typeof VerificationOutcome>;

/**
 * The result of checking a finding against an IMMUTABLE post-merge head.
 *
 * `subjectSha` is required and is the sha the verification actually inspected —
 * a verification without a subject is an opinion, and one whose subject is not
 * the current post-merge head must be re-run rather than reused. `indeterminate`
 * is a first-class outcome, never rounded to `resolved`: "the verifier could not
 * read the file" and "the defect is gone" are not the same fact.
 */
export const FindingVerification = z.object({
  outcome: VerificationOutcome,
  detail: z.string().min(1),
  subjectSha: Sha40,
  verifierId: z.string().min(1),
});
export type FindingVerification = z.infer<typeof FindingVerification>;

/** A human closing the child issue outside Scruffy. Recorded, never reinterpreted. */
export const ExternalDismissal = z.object({
  /** Provider actor login where available; null when the provider withheld it. */
  actor: z.string().nullable(),
  /** Provider `state_reason` (e.g. `completed`, `not_planned`) where available. */
  stateReason: z.string().nullable(),
  at: z.date(),
});
export type ExternalDismissal = z.infer<typeof ExternalDismissal>;

export interface FindingResolutionInput {
  /** Merge state of the delivered proposal, or null when nothing was delivered. */
  merge: ProposalMergeState | null;
  /** Verification against the post-merge head, or null when not yet attempted. */
  verification: FindingVerification | null;
  /** An external (human) dismissal of the child issue, or null. */
  dismissal: ExternalDismissal | null;
}

/**
 * The resolution a child finding work item should hold.
 *
 * Order of precedence, and why:
 *
 *  1. A CONCLUSIVE verification that the defect is gone resolves the finding.
 *     This is the only path to `resolved`; nothing about a PR (opened, green,
 *     approved, merged) reaches it.
 *  2. Otherwise an external dismissal dismisses it — a human's explicit decision,
 *     recorded as a dismissal with their actor/reason and never upgraded to
 *     "verified". (A human closing an already-verified child agrees with case 1,
 *     so that stays `resolved`.)
 *  3. Otherwise a merged proposal moves it to `awaiting_verification` — including
 *     when verification came back INDETERMINATE, because "we could not tell" is
 *     still awaiting an answer, not an answer.
 *  4. Otherwise it is `open`. That includes a merge whose verification found the
 *     defect STILL PRESENT: the patch did not do the job, and pretending we are
 *     still waiting would hide that.
 */
export function deriveFindingResolution(input: FindingResolutionInput): FindingResolution {
  if (input.verification?.outcome === "resolved") return "resolved";
  if (input.dismissal !== null) return "dismissed";
  if (input.merge === "merged") {
    return input.verification === null || input.verification.outcome === "indeterminate" ? "awaiting_verification" : "open";
  }
  return "open";
}

/** True when a resolution is terminal — the parent may stop waiting on it. */
export function isTerminalResolution(resolution: FindingResolution): boolean {
  return resolution === "resolved" || resolution === "dismissed";
}

// ── Parent closure ──────────────────────────────────────────────────────────

export interface ParentChildState {
  workItemId: string;
  title: string;
  resolution: FindingResolution;
  /** True when the proposal for this child could not be delivered at all. */
  deliveryFailed: boolean;
  /** True when the child's own issue could not be published. */
  publicationFailed: boolean;
}

export interface ParentClosureInput {
  /** From the durable report: false while any REQUIRED coverage gap stands. */
  requiredCoverageComplete: boolean;
  children: readonly ParentChildState[];
}

export interface ParentClosure {
  close: boolean;
  /** Human-readable blockers, rendered onto the parent issue and the check. */
  blockers: string[];
}

/**
 * May the parent nightly work item close?
 *
 * Only when the review was COMPLETE (no required coverage gap left blind) and
 * every child is terminal. A child that is open or awaiting verification blocks;
 * so does a child whose fix PR or issue could not be delivered, because an
 * undelivered child is work a human never saw. Blockers are returned rather than
 * summarised as a boolean so the parent body can say exactly what it is waiting
 * on instead of "still open".
 */
export function deriveParentClosure(input: ParentClosureInput): ParentClosure {
  const blockers: string[] = [];
  if (!input.requiredCoverageComplete) {
    blockers.push("required analyzer coverage is incomplete");
  }
  for (const child of input.children) {
    if (!isTerminalResolution(child.resolution)) {
      blockers.push(`${child.workItemId} is ${child.resolution}`);
      if (child.deliveryFailed) blockers.push(`${child.workItemId} fix delivery failed`);
      if (child.publicationFailed) blockers.push(`${child.workItemId} issue publication failed`);
    }
  }
  return { close: blockers.length === 0, blockers };
}

// ── Rendering ───────────────────────────────────────────────────────────────

export interface FixLifecycleView {
  delivery: ProposalDelivery;
  ci: ProposalCiState;
  /** The sha the CI verdict belongs to; null when not yet known for this head. */
  ciHeadSha: string | null;
  merge: ProposalMergeState;
  pr: { number: number; url: string } | null;
  deliveryError: string | null;
  verification: FindingVerification | null;
  dismissal: ExternalDismissal | null;
  resolution: FindingResolution;
}

/**
 * Markdown block describing one child's remediation lifecycle, appended to the
 * child issue body and reused in the parent/check summary. Derived entirely from
 * durable state — the issue body is a projection, never a second source of truth.
 */
export function renderFixLifecycle(view: FixLifecycleView): string {
  const lines = ["## Remediation", `- Resolution: \`${view.resolution}\``, `- Delivery: \`${view.delivery}\``];
  if (view.deliveryError !== null) lines.push(`- Delivery error: ${view.deliveryError}`);
  lines.push(
    view.pr === null ? "- Pull request: none" : `- Pull request: #${view.pr.number} (${view.pr.url})`,
    view.ciHeadSha === null
      ? `- Repository CI: \`${view.ci}\` (no evidence for the current PR head yet)`
      : `- Repository CI: \`${view.ci}\` at \`${view.ciHeadSha}\``,
    `- Merge: \`${view.merge}\``,
  );
  lines.push(
    view.verification === null
      ? "- Post-merge verification: not attempted"
      : `- Post-merge verification: \`${view.verification.outcome}\` at \`${view.verification.subjectSha}\` — ${view.verification.detail}`,
  );
  if (view.dismissal !== null) {
    lines.push(
      `- Externally dismissed by \`${view.dismissal.actor ?? "unknown"}\`` +
        ` (reason: \`${view.dismissal.stateReason ?? "unspecified"}\`)`,
    );
  }
  lines.push(
    "",
    "A pull request, a green CI run, an approval, and a merge do **not** close this item. " +
      "It closes when Scruffy verifies the defect is gone at the post-merge head, or when a human dismisses it.",
  );
  return lines.join("\n");
}

/** Parent-issue/check block: what the run is still waiting on. */
export function renderParentClosure(closure: ParentClosure): string {
  if (closure.close) return "## Status\n\nAll child items are resolved or dismissed and required coverage is complete.";
  return ["## Status", "", "This run stays open until:", ...closure.blockers.map((b) => `- ${b}`)].join("\n");
}
