import type { AnalysisCoverage, CoverageGap } from "../evidence/coverage.js";
import type { ExternalDismissal, FindingVerification, ParentClosure } from "../fixes/lifecycle.js";
import { renderParentClosure } from "../fixes/lifecycle.js";
import {
  requiredCoverageGaps,
  type FindingResolution,
  type NightlyReportSummary,
  type NightlyWorkItemKind,
  type ProposalCiState,
  type ProposalDelivery,
  type ProposalMergeState,
  type RemediationState,
} from "./work-graph.js";

/**
 * The MORNING SUMMARY: one rendering of a nightly run, used by both operator
 * surfaces.
 *
 * A human arriving in the morning has exactly two places to look — the parent
 * nightly issue and the `scruffy/nightly` check — and before this module they were
 * rendered by two different code paths from two different inputs. That is how a
 * check ends up saying "3 open items" next to an issue that lists two, or how a
 * refreshed check loses the coverage gap the original post had. So both surfaces
 * call THIS function, over persisted report + lifecycle state, and are congruent by
 * construction rather than by review.
 *
 * THREE RULES, in priority order:
 *
 *  1. COVERAGE BEFORE FINDING COUNTS, in the title and in the body. "0 findings"
 *     from an analyzer that could not look is the single most dangerous sentence
 *     this system can emit, so the first thing either surface says is whether the
 *     range was completely reviewed. A run with a required gap is never titled with
 *     a finding count alone and never uses the word "clean".
 *  2. EVERY EXTERNAL ARTEFACT IS NAMED AND LINKED. Parent issue, each child issue,
 *     each pull request — with its delivery state, the sha its CI verdict belongs
 *     to, and its merge state. A human must be able to get from the summary to the
 *     thing they have to act on without searching.
 *  3. FAILED AND UNAVAILABLE WORK IS LOUD. An issue that could not be published, a
 *     patch that could not be delivered, and a finding no fixer or model could serve
 *     are listed in their own section. Silence about work Scruffy failed to do reads
 *     as work that was not needed.
 *
 * PURE. No IO, no clock, no provider. Everything comes from the caller's durable
 * view, which is what lets the same render be asserted in a test and trusted in
 * production.
 */

/** One child work item as the morning surfaces need it. Provider-neutral handles. */
export interface MorningChildView {
  workItemId: string;
  kind: NightlyWorkItemKind;
  title: string;
  resolution: FindingResolution;
  /** The published child issue, or null when publication never succeeded. */
  issue: { number: number; url: string } | null;
  /** Why the child issue could not be published, when it could not be. */
  publicationError: string | null;
  /**
   * The remediation attempt's durable outcome for this finding. Null for a coverage
   * gap (nothing to remediate) and for a finding whose attempt is not recorded on
   * the view.
   */
  remediation: { state: RemediationState; reason: string } | null;
  /** The delivered proposal, or null when nothing was ever proposed. */
  proposal: {
    delivery: ProposalDelivery;
    ci: ProposalCiState;
    /** The commit the CI verdict belongs to; null when unknown for the PR head. */
    ciHeadSha: string | null;
    merge: ProposalMergeState;
    pr: { number: number; url: string } | null;
    deliveryError: string | null;
  } | null;
  verification: FindingVerification | null;
  dismissal: ExternalDismissal | null;
}

export interface MorningSummaryInput {
  repository: string;
  branch: string;
  /** The immutable reviewed candidate this report owns. */
  headSha: string;
  baseSha: string | null;
  reportId: string;
  requiredCoverageComplete: boolean;
  /** Persisted analyzer coverage. Required gaps are re-derived, never trusted. */
  coverage: AnalysisCoverage;
  summary: NightlyReportSummary;
  parent: { workItemId: string; issue: { number: number; url: string } | null } | null;
  children: readonly MorningChildView[];
  /** Closure derivation for this run (`deriveParentClosure`). */
  closure: ParentClosure;
}

export interface MorningSummary {
  /** Check-run title. Coverage first, finding counts second. */
  title: string;
  /** Markdown body, shared verbatim by the parent issue and the check summary. */
  body: string;
}

/**
 * The nightly check/issue TITLE, shared by the gate's first post and every refresh.
 *
 * `openItems` is null at gate time, when no lifecycle exists yet, and a number once
 * children have resolutions. Both forms lead with coverage; only the complete form
 * is ever allowed to say `clean`, and only when nothing surfaced.
 */
export function nightlyReviewTitle(input: {
  requiredCoverageComplete: boolean;
  requiredGaps: number;
  surfaced: number;
  proposals: number;
  openItems: number | null;
}): string {
  const { surfaced, proposals, requiredGaps, openItems } = input;
  const fixes = proposals > 0 ? ` (${proposals} fix${proposals === 1 ? "" : "es"} proposed)` : "";
  const findings = `${surfaced} finding${surfaced === 1 ? "" : "s"}${fixes}`;

  if (!input.requiredCoverageComplete) {
    // Coverage leads, and the word INCOMPLETE is not negotiable: this is the title
    // that must never be mistaken for a quiet night.
    const open = openItems === null ? "" : `, ${openItems} open item${openItems === 1 ? "" : "s"}`;
    return `Nightly review: INCOMPLETE — ${requiredGaps} coverage gap${requiredGaps === 1 ? "" : "s"}, ${findings}${open}`;
  }
  if (openItems === null) return surfaced === 0 ? "Nightly review: clean" : `Nightly review: ${findings}`;
  if (openItems === 0) {
    return surfaced === 0 ? "Nightly review: clean" : "Nightly review: all items resolved or dismissed";
  }
  return `Nightly review: ${findings}, ${openItems} open item${openItems === 1 ? "" : "s"}`;
}

/**
 * Count the items a human still owes this run. Deliberately NOT `closure.blockers`,
 * which may name more than one problem per child (e.g. open AND delivery failed):
 * a title that said "3 open items" for two children would overstate the work.
 *
 * Incomplete coverage is itself an owed item, but normally it is ALREADY one of the
 * children (every required gap becomes a coverage-gap work item), so it is only added
 * separately when no unresolved coverage child represents it — otherwise the one gap
 * would be counted twice and the title would overstate the morning's work.
 */
export function openItemCount(input: Pick<MorningSummaryInput, "requiredCoverageComplete" | "children">): number {
  const unresolved = input.children.filter((c) => c.resolution !== "resolved" && c.resolution !== "dismissed");
  const coverageIsAChild = unresolved.some((c) => c.kind === "coverage_gap");
  return unresolved.length + (input.requiredCoverageComplete || coverageIsAChild ? 0 : 1);
}

export function renderMorningSummary(input: MorningSummaryInput): MorningSummary {
  const gaps = requiredCoverageGaps(input.coverage);
  const openItems = openItemCount(input);

  return {
    title: nightlyReviewTitle({
      requiredCoverageComplete: input.requiredCoverageComplete,
      requiredGaps: gaps.length,
      surfaced: input.summary.surfaced,
      proposals: input.summary.proposals,
      openItems,
    }),
    body: [
      ...coverageSection(input, gaps),
      "",
      ...findingSection(input),
      "",
      ...workSection(input),
      ...unavailableSection(input),
      "",
      renderParentClosure(input.closure),
      "",
      NO_AUTO_MERGE,
    ].join("\n"),
  };
}

const NO_AUTO_MERGE =
  "Scruffy never merges its own pull requests and never changes branch protection. " +
  "A human merges or closes each fix PR, and a human may dismiss any item by closing its issue. " +
  "A green repository CI run is supporting evidence, not proof of correctness — a merged fix clears its " +
  "finding only after Scruffy verifies the defect is gone at the immutable post-merge head.";

/**
 * Coverage FIRST — the section order is the whole point of this module. An
 * incomplete run states the held watermark in the same breath, because "we did not
 * look at all of it" and "so this range is still owed" are one fact for an operator.
 */
function coverageSection(input: MorningSummaryInput, gaps: readonly CoverageGap[]): string[] {
  const range = `${input.baseSha === null ? "(first review)" : short(input.baseSha)} … ${short(input.headSha)}`;
  const lines = [
    "## Coverage",
    "",
    `Range: \`${range}\` on \`${input.repository}@${input.branch}\` (report \`${input.reportId}\`).`,
    "",
  ];
  if (input.requiredCoverageComplete) {
    lines.push("Required analyzer coverage is **complete** for this range.");
    return lines;
  }
  lines.push(
    `Required analyzer coverage is **INCOMPLETE** — ${gaps.length} required gap${gaps.length === 1 ? "" : "s"}. ` +
      "This is not a clean bill of health: the complete-review watermark is HELD at the previous complete head, " +
      "so this range stays owed and a later bounded attempt re-reviews it.",
    "",
    ...gaps.map((gap) => `- \`${gap.analyzerId}\`: \`${gap.code}\` — ${gap.detail || "no detail reported"}`),
  );
  return lines;
}

/** Finding counts, strictly AFTER coverage. */
function findingSection(input: MorningSummaryInput): string[] {
  const { surfaced, suppressed, proposals } = input.summary;
  return [
    "## Findings",
    "",
    `- surfaced (human work): ${surfaced}`,
    `- fix proposals: ${proposals}`,
    `- suppressed or refuted (audit record only, no issue): ${suppressed}`,
  ];
}

/** Parent, children, and pull requests — every external artefact, with its link. */
function workSection(input: MorningSummaryInput): string[] {
  const lines = ["## Work items", ""];
  lines.push(
    input.parent === null
      ? "- Parent: none — this run planned no work items."
      : input.parent.issue === null
        ? `- Parent: \`${input.parent.workItemId}\` — **issue not published** (the run is durable; the issue is not)`
        : `- Parent: [#${input.parent.issue.number}](${input.parent.issue.url})`,
  );
  if (input.children.length === 0) {
    lines.push("- Children: none.");
    return lines;
  }
  for (const child of input.children) {
    lines.push(...childLines(child));
  }
  return lines;
}

function childLines(child: MorningChildView): string[] {
  const label = child.kind === "coverage_gap" ? "coverage gap" : "finding";
  const issue =
    child.issue === null
      ? `**issue not published**${child.publicationError === null ? "" : ` (${child.publicationError})`}`
      : `[#${child.issue.number}](${child.issue.url})`;
  const lines = [`- \`${child.resolution}\` ${label} — ${child.title} → ${issue}`];

  if (child.proposal !== null) {
    const proposal = child.proposal;
    const pr = proposal.pr === null ? "no pull request" : `PR [#${proposal.pr.number}](${proposal.pr.url})`;
    // The sha is carried with the verdict deliberately: a CI state without the commit
    // it was read at is exactly the claim this system refuses to make.
    const ci =
      proposal.ciHeadSha === null
        ? `CI \`${proposal.ci}\` (no evidence for the current PR head)`
        : `CI \`${proposal.ci}\` at \`${short(proposal.ciHeadSha)}\``;
    lines.push(`  - ${pr} — delivery \`${proposal.delivery}\`, ${ci}, merge \`${proposal.merge}\``);
    if (proposal.delivery === "draft_open") {
      lines.push("  - Opened as a DRAFT: structurally safe and policy-compliant, but not independently confirmed.");
    }
    if (proposal.deliveryError !== null) {
      lines.push(`  - **Fix delivery failed**: ${proposal.deliveryError} — this item has no pull request to review.`);
    }
  } else if (child.kind === "finding") {
    lines.push(`  - No pull request: ${remediationPhrase(child.remediation)}`);
  }

  if (child.verification !== null) {
    lines.push(
      `  - Post-merge verification: \`${child.verification.outcome}\` at \`${short(child.verification.subjectSha)}\`` +
        ` — ${child.verification.detail}`,
    );
  } else if (child.proposal?.merge === "merged") {
    lines.push("  - Post-merge verification: not yet attempted — the merge does NOT resolve this item.");
  }
  if (child.dismissal !== null) {
    lines.push(
      `  - Dismissed by \`${child.dismissal.actor ?? "unknown"}\` (reason: \`${child.dismissal.stateReason ?? "unspecified"}\`)` +
        " — recorded as a human decision, not as a verified fix.",
    );
  }
  return lines;
}

/**
 * Work Scruffy could not do, restated in one place.
 *
 * The same facts already appear per child above; an operator scanning for "what is
 * broken about the robot, as opposed to the code" should not have to read every
 * child to find it. Empty section is omitted rather than rendered as "none", so its
 * presence is itself the signal.
 */
function unavailableSection(input: MorningSummaryInput): string[] {
  const lines: string[] = [];
  for (const child of input.children) {
    if (child.publicationError !== null) {
      lines.push(`- \`${child.workItemId}\`: child issue could not be published — ${child.publicationError}`);
    }
    if (child.proposal?.deliveryError !== null && child.proposal?.deliveryError !== undefined) {
      lines.push(`- \`${child.workItemId}\`: fix delivery failed — ${child.proposal.deliveryError}`);
    }
    if (child.proposal === null && child.kind === "finding" && child.remediation !== null && child.remediation.state !== "proposed") {
      lines.push(`- \`${child.workItemId}\`: no patch (\`${child.remediation.state}\`) — ${child.remediation.reason}`);
    }
  }
  if (lines.length === 0) return [];
  return ["", "## Failed or unavailable work", "", ...lines];
}

function remediationPhrase(remediation: { state: RemediationState; reason: string } | null): string {
  if (remediation === null) return "no remediation attempt is recorded for this item.";
  return `remediation \`${remediation.state}\` (\`${remediation.reason}\`) — this item needs a human fix.`;
}

function short(sha: string): string {
  return sha.slice(0, 12);
}
