import type { CheckConclusion } from "../providers/scm/port.js";
import type { SubjectRevision } from "../domain/evidence/types.js";
import type { NightlyReport, NightlyWorkGraph, NightlyWorkItem } from "../domain/findings/work-graph.js";
import {
  issueLabelsFor,
  workItemIssueMarker,
  type EffectDependency,
  type EffectProduction,
} from "../domain/findings/work-publication.js";
import {
  NIGHTLY_CHECK_REFRESH_EFFECT,
  NIGHTLY_ISSUE_EFFECT,
  NIGHTLY_ISSUE_LINK_EFFECT,
  NIGHTLY_ISSUE_SUMMARY_EFFECT,
  type NightlyCheckRefreshPayload,
  type NightlyIssueLinkPayload,
  type NightlyIssuePayload,
  type NightlyIssueSummaryPayload,
} from "./issues.js";

/**
 * Plan the outbox effects that publish a nightly work graph as one parent issue
 * with native child issues.
 *
 * PURE. It maps the durable graph to effects and their DECLARED dependencies; it
 * performs no IO and calls no provider. Analysis/gate code enqueues what this
 * returns, the effects component is the only thing that talks to GitHub.
 *
 * The dependency graph, and why each edge exists:
 *
 *   parent issue                       (produces parent issue_reference)
 *     ├─ child issue        ← needs parent issue_reference   (the child body links the parent)
 *     │    └─ attach child  ← needs parent + child issue_reference
 *     └─ parent body update ← needs parent issue_reference + EVERY child settled
 *   check refresh           ← needs EVERY child settled (parent included), and
 *                             deliberately NOT the parent reference: when publication
 *                             failed, the honest check is the whole point.
 *
 * "Settled" means terminal either way — published or failed — so a partly failed
 * graph still reconciles instead of hanging. Nothing here relies on row insertion
 * order: every edge is a row in `outbox_dependencies` that the claim query enforces.
 */

/** An outbox effect plus the dependency edges the store must persist with it. */
export interface PlannedEffect {
  effectType: string;
  externalId: string;
  payload: unknown;
  produces?: EffectProduction;
  dependsOn?: readonly EffectDependency[];
}

/** The check the report already rendered; the refresh re-posts it with publication state. */
export interface PlannedCheck {
  subject: SubjectRevision;
  externalId: string;
  name: string;
  conclusion: CheckConclusion;
  title: string;
  summary: string;
}

export interface PublicationPlanInput {
  report: NightlyReport;
  workGraph: NightlyWorkGraph;
  check: PlannedCheck;
}

/**
 * External ids are derived from the immutable work-item ids, so re-committing the
 * same report reuses the same outbox rows (`unique (run_id, external_id)`) and a
 * later candidate's identical-looking work is a different row.
 */
function issueExternalId(workItemId: string): string {
  return `nightly-issue:${workItemId}`;
}

export function planIssuePublicationEffects(input: PublicationPlanInput): PlannedEffect[] {
  const { report, workGraph, check } = input;
  // A complete, clean run planned no work. Publishing nothing is the product
  // decision, not an omission: an empty issue for a human to close is noise.
  if (workGraph.parent === null) return [];

  const repository = report.identity.repository;
  const parent = workGraph.parent;
  const parentMarker = workItemIssueMarker(parent.workItemId);
  const parentLabels = issueLabelsFor(parent.kind);

  const effects: PlannedEffect[] = [];

  const parentPayload: NightlyIssuePayload = {
    workItemId: parent.workItemId,
    reportId: report.reportId,
    kind: parent.kind,
    repository,
    marker: parentMarker,
    labels: parentLabels,
    title: parent.title,
    body: parent.body,
    parentWorkItemId: null,
  };
  effects.push({
    effectType: NIGHTLY_ISSUE_EFFECT,
    externalId: issueExternalId(parent.workItemId),
    payload: parentPayload,
    produces: { workItemId: parent.workItemId, kind: "issue_reference" },
  });

  for (const child of workGraph.children) {
    effects.push(childIssueEffect(report, repository, parent, child));
    const linkPayload: NightlyIssueLinkPayload = {
      repository,
      parentWorkItemId: parent.workItemId,
      childWorkItemId: child.workItemId,
    };
    effects.push({
      effectType: NIGHTLY_ISSUE_LINK_EFFECT,
      externalId: `nightly-issue-link:${child.workItemId}`,
      payload: linkPayload,
      produces: { workItemId: child.workItemId, kind: "attachment" },
      dependsOn: [
        { workItemId: parent.workItemId, requires: "issue_reference" },
        { workItemId: child.workItemId, requires: "issue_reference" },
      ],
    });
  }

  // Both reconciliation effects wait for the SAME settled set, so they observe one
  // consistent publication state rather than racing the children they report on.
  const settled: EffectDependency[] = [
    { workItemId: parent.workItemId, requires: "publication_settled" },
    ...workGraph.children.flatMap((child): EffectDependency[] => [
      { workItemId: child.workItemId, requires: "publication_settled" },
      { workItemId: child.workItemId, requires: "attachment_settled" },
    ]),
  ];

  const summaryPayload: NightlyIssueSummaryPayload = {
    reportId: report.reportId,
    parentWorkItemId: parent.workItemId,
    repository,
    marker: parentMarker,
    labels: parentLabels,
    title: parent.title,
    body: parent.body,
  };
  effects.push({
    effectType: NIGHTLY_ISSUE_SUMMARY_EFFECT,
    externalId: `nightly-issue-summary:${parent.workItemId}`,
    payload: summaryPayload,
    dependsOn: [{ workItemId: parent.workItemId, requires: "issue_reference" }, ...settled],
  });

  const refreshPayload: NightlyCheckRefreshPayload = {
    reportId: report.reportId,
    parentWorkItemId: parent.workItemId,
    subject: check.subject,
    // The SAME external id as the initial check, so this is an idempotent UPDATE of
    // one check run rather than a second check competing with it.
    externalId: check.externalId,
    name: check.name,
    conclusion: check.conclusion,
    title: check.title,
    summary: check.summary,
  };
  effects.push({
    effectType: NIGHTLY_CHECK_REFRESH_EFFECT,
    // Distinct from the check effect's external id: `unique (run_id, external_id)`
    // is the outbox ROW key, and reusing it would collapse the two effects into one.
    externalId: `nightly-check-refresh:${parent.workItemId}`,
    payload: refreshPayload,
    dependsOn: settled,
  });

  return effects;
}

function childIssueEffect(
  report: NightlyReport,
  repository: string,
  parent: NightlyWorkItem,
  child: NightlyWorkItem,
): PlannedEffect {
  const payload: NightlyIssuePayload = {
    workItemId: child.workItemId,
    reportId: report.reportId,
    kind: child.kind,
    repository,
    marker: workItemIssueMarker(child.workItemId),
    labels: issueLabelsFor(child.kind),
    title: child.title,
    body: child.body,
    parentWorkItemId: parent.workItemId,
  };
  return {
    effectType: NIGHTLY_ISSUE_EFFECT,
    externalId: issueExternalId(child.workItemId),
    payload,
    produces: { workItemId: child.workItemId, kind: "issue_reference" },
    dependsOn: [{ workItemId: parent.workItemId, requires: "issue_reference" }],
  };
}
