import type {
  FindingResolution,
  FindingVisibility,
  ProposalCiState,
  ProposalDelivery,
  ProposalMergeState,
  RemediationState,
} from "./work-graph.js";

/**
 * PROVIDER-NEUTRAL, READ-ONLY query boundary over durable nightly evidence.
 *
 * Why it exists now: release-report aggregation will want to say "here is what
 * nightly already knows about this candidate" without either gate reaching into the
 * other's tables. So the boundary is defined and tested here, in the shape a later
 * aggregation would consume, while the release gate stays exactly as authoritative
 * (and exactly as unaware) as it is today.
 *
 * Three properties are the point:
 *
 *  - READ ONLY. The port has no mutating method. Aggregation can observe the fix
 *    lifecycle; it can never advance, resolve, or dismiss anything through it.
 *  - PROVIDER-NEUTRAL. Issues and pull requests appear as `{number, url}` handles,
 *    not as GitHub payloads, so a second SCM adapter needs no change here.
 *  - NOT AUTHORITATIVE. Nothing in this module decides a release outcome, and
 *    nothing in `gates/release/` imports it. A nightly finding is advisory evidence;
 *    release keeps its own gate, its own report contract, and its own campaign
 *    boundary.
 */

/** One finding occurrence as durable evidence — including suppressed ones (audit). */
export interface NightlyEvidenceFinding {
  occurrenceId: string;
  findingKey: string;
  ruleId: string;
  defectClass: string;
  path: string;
  startLine: number;
  endLine: number;
  visibility: FindingVisibility;
  visibilityReason: string;
  resolution: FindingResolution;
  /** Null exactly when no remediation is owed (a suppressed finding). */
  remediation: { state: RemediationState; reason: string } | null;
  /** Null when nothing was ever proposed for this occurrence. */
  proposal: {
    proposalId: string;
    delivery: ProposalDelivery;
    ci: ProposalCiState;
    /** The commit the CI verdict belongs to; null when unknown for the PR head. */
    ciHeadSha: string | null;
    merge: ProposalMergeState;
    pullRequest: { number: number; url: string } | null;
    deliveryError: string | null;
  } | null;
  /** The newest post-merge verification for this occurrence, or null. */
  verification: { outcome: string; subjectSha: string; detail: string } | null;
  /** True when a human explicitly dismissed this occurrence's work item. */
  dismissed: boolean;
}

export interface NightlyEvidenceReport {
  reportId: string;
  repository: string;
  branch: string;
  baseSha: string | null;
  headSha: string;
  policyVersion: string;
  /** False while any REQUIRED analyzer coverage gap stands for this range. */
  requiredCoverageComplete: boolean;
  summary: { surfaced: number; suppressed: number; proposals: number; requiredGaps: number };
  coverageGaps: { analyzerId: string; code: string; detail: string }[];
  /** The parent run issue, when it was published. */
  parentIssue: { number: number; url: string } | null;
  findings: NightlyEvidenceFinding[];
  createdAt: Date;
}

export interface NightlyEvidenceQueryInput {
  repository: string;
  /** Restrict to one reviewed branch. */
  branch?: string;
  /** Restrict to reports whose reviewed candidate is exactly this sha. */
  candidateSha?: string;
  /** Newest-first bound. Default 20. */
  limit?: number;
}

/** The read side. Deliberately the ONLY method: there is nothing to write here. */
export interface NightlyEvidenceReadPort {
  reports(input: NightlyEvidenceQueryInput & { limit: number }): Promise<NightlyEvidenceReport[]>;
}

/**
 * A roll-up over the matching reports. Every count is derived from the persisted
 * reports in the same snapshot, so an aggregation cannot be shown a total that
 * disagrees with the detail it can also read.
 */
export interface NightlyEvidenceSnapshot {
  repository: string;
  branch: string | null;
  candidateSha: string | null;
  reports: NightlyEvidenceReport[];
  /** True only when EVERY matching report completely reviewed its range. */
  requiredCoverageComplete: boolean;
  /** Reports that did not completely review their range. */
  incompleteReports: number;
  surfacedFindings: number;
  openFindings: number;
  awaitingVerification: number;
  resolvedFindings: number;
  dismissedFindings: number;
  /** Proposals that reached a human as a pull request, draft or ready. */
  openProposals: number;
  /** Proposals that could not be delivered at all — visible, never silent. */
  failedProposals: number;
}

/**
 * Pure roll-up. Exported so the same derivation is testable without a database and
 * reusable by whatever renders it.
 *
 * `requiredCoverageComplete` is false for an EMPTY result set on purpose: the
 * question it answers is "has nightly completely reviewed this?", and the answer for
 * something never reviewed is no.
 */
export function summarizeNightlyEvidence(
  scope: { repository: string; branch: string | null; candidateSha: string | null },
  reports: readonly NightlyEvidenceReport[],
): NightlyEvidenceSnapshot {
  const snapshot: NightlyEvidenceSnapshot = {
    repository: scope.repository,
    branch: scope.branch,
    candidateSha: scope.candidateSha,
    reports: [...reports],
    requiredCoverageComplete: reports.length > 0,
    incompleteReports: 0,
    surfacedFindings: 0,
    openFindings: 0,
    awaitingVerification: 0,
    resolvedFindings: 0,
    dismissedFindings: 0,
    openProposals: 0,
    failedProposals: 0,
  };

  for (const report of reports) {
    if (!report.requiredCoverageComplete) {
      snapshot.requiredCoverageComplete = false;
      snapshot.incompleteReports += 1;
    }
    for (const finding of report.findings) {
      if (finding.visibility !== "surfaced") continue;
      snapshot.surfacedFindings += 1;
      switch (finding.resolution) {
        case "open":
          snapshot.openFindings += 1;
          break;
        case "awaiting_verification":
          snapshot.awaitingVerification += 1;
          break;
        case "resolved":
          snapshot.resolvedFindings += 1;
          break;
        case "dismissed":
          snapshot.dismissedFindings += 1;
          break;
      }
      if (finding.proposal === null) continue;
      if (finding.proposal.delivery === "delivery_failed") snapshot.failedProposals += 1;
      else if (finding.proposal.delivery !== "queued") snapshot.openProposals += 1;
    }
  }
  return snapshot;
}
