import type { PlannedEffect } from "../../effects/publication-plan.js";
import type { PullRequestPayload } from "../../effects/pull-request.js";
import { fixProposalExternalId, renderFixPullRequestBody, type FixDeliveryReadiness } from "../../domain/fixes/delivery.js";
import type { NightlyReport, NightlyReportFinding, NightlyWorkGraph } from "../../domain/findings/work-graph.js";

/**
 * Plan the outbox effects that DELIVER fix proposals as pull requests.
 *
 * Split from `planIssuePublicationEffects` because the two answer different
 * questions — that one publishes the work a human must see, this one publishes the
 * patch Scruffy is offering — but they share one dependency graph: a fix PR waits
 * on its child finding issue's reference, so the PR body a human opens already
 * links the issue it remediates instead of pointing at nothing.
 *
 * PURE, and a function of the DURABLE REPORT ALONE. No IO, no provider call, no
 * clock, and no side channel from the remediation run: everything the PR says
 * (readiness, validation reason, provenance, edits, identity) is already on the
 * persisted proposal record. That is what makes a re-drive converge on the same
 * effect rows instead of opening a second, differently-worded PR.
 *
 * Two properties this exists to guarantee:
 *
 *  - CANDIDATE-BOUND IDENTITY. Both the branch (derived by `buildNightlyReport`)
 *    and the SCM idempotency key come from `fixProposalId`, which transitively
 *    binds repository, branch, base sha, candidate head sha, policy version, the
 *    normalized finding key, and the fixer/prompt/schema versions. The same defect
 *    at the same line on a LATER candidate is a different proposal, so it can never
 *    be matched to — and silently treated as delivered by — an older, possibly
 *    human-closed PR.
 *  - HONEST READINESS. A confirmed patch opens ready for review; a structurally
 *    safe but semantically unconfirmed patch opens as a draft and says so in its
 *    title and in the first line of its body. Nothing here merges anything.
 */

export interface FixDeliveryPlanInput {
  report: NightlyReport;
  workGraph: NightlyWorkGraph;
}

export function planFixDeliveryEffects(input: FixDeliveryPlanInput): PlannedEffect[] {
  const { report, workGraph } = input;
  if (workGraph.parent === null) return [];

  const identity = report.identity;
  const parent = workGraph.parent;
  const childByOccurrence = new Map(
    workGraph.children.flatMap((child) => (child.occurrenceId === null ? [] : [[child.occurrenceId, child] as const])),
  );

  const effects: PlannedEffect[] = [];
  for (const finding of report.findings) {
    const proposal = finding.remediation?.proposal;
    if (finding.visibility !== "surfaced" || proposal === null || proposal === undefined) continue;

    // No child work item means no issue to link and no human-visible home for the
    // patch. That combination is a planner bug, not a delivery decision, so nothing
    // is delivered rather than an orphan PR being opened against no tracked work.
    const child = childByOccurrence.get(finding.occurrenceId);
    if (child === undefined) continue;

    const readiness = proposal.readiness;
    const payload: PullRequestPayload = {
      subject: { repository: identity.repository, commitSha: identity.headSha },
      externalId: fixProposalExternalId(proposal.proposalId),
      branch: proposal.branch,
      // The fix targets the branch this nightly review ran on — opening it against
      // the repository default branch would propose the patch to the wrong history
      // whenever nightly reviews a non-default branch.
      baseBranch: identity.branch,
      baseSha: identity.baseSha,
      title: fixTitle(finding, readiness),
      body: renderFixPullRequestBody({
        report: identity,
        reportId: report.reportId,
        proposalId: proposal.proposalId,
        occurrenceId: finding.occurrenceId,
        defectClass: finding.defectClass,
        ruleId: finding.ruleId,
        provenance: proposal.provenance,
        readiness,
        validationState: proposal.validationReason,
        // Neither issue exists yet: this effect is only claimed once the child
        // reference is on record, and the dispatcher appends the real links then.
        // Rendering "not published yet" here would freeze a lie into the PR body.
        childIssue: null,
        parentIssue: null,
        edits: proposal.edits,
        findingSummary: findingSummary(finding),
      }),
      edits: proposal.edits,
      proposalId: proposal.proposalId,
      workItemId: child.workItemId,
      parentWorkItemId: parent.workItemId,
      draft: readiness === "draft",
      provenance: proposal.provenance,
    };

    effects.push({
      effectType: "pull_request",
      externalId: payload.externalId,
      payload,
      // The PR body links the finding issue, so that reference must exist first. If
      // the child issue can never be published this cascades to a terminal delivery
      // failure that stays visible on the parent — the honest outcome, rather than a
      // PR pointing at work no human was ever told about.
      dependsOn: [{ workItemId: child.workItemId, requires: "issue_reference" }],
    });
  }
  return effects;
}

/**
 * A draft says so in its title as well as its body. GitHub renders its own draft
 * badge, but the title is what appears in notification emails and PR lists, and
 * "clearly marked" has to survive those surfaces too.
 */
function fixTitle(finding: NightlyReportFinding, readiness: FixDeliveryReadiness): string {
  const subject = `fix(${finding.defectClass}): ${finding.region.path}:${finding.region.startLine}`;
  return readiness === "draft" ? `[unconfirmed] ${subject}` : subject;
}

function findingSummary(finding: NightlyReportFinding): string {
  return [
    `\`${finding.ruleId}\` at \`${finding.region.path}:${finding.region.startLine}-${finding.region.endLine}\`.`,
    "",
    `- adversarial validation: \`${finding.validation}\``,
    `- deterministic support: ${finding.deterministicSupport ? "yes" : "no"}`,
    `- surfaced because: \`${finding.visibilityReason}\``,
  ].join("\n");
}
