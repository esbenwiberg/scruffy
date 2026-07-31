import { z } from "zod";
import { SubjectRevision } from "../domain/evidence/types.js";
import type { CheckConclusion, CheckRunInput } from "../providers/scm/port.js";
import type { PoisonDecision } from "../gates/poison/decision.js";
import { requiredCoverageGaps, type NightlyReport } from "../domain/findings/work-graph.js";
import { nightlyReviewTitle } from "../domain/findings/morning-summary.js";
import type { ReleaseRiskReport } from "../domain/release/report.js";
import { signoffResponsibility } from "../domain/release/signoff.js";

export const CHECK_NAME = "scruffy/poison";
export const NIGHTLY_CHECK_NAME = "scruffy/nightly";
export const RELEASE_CHECK_NAME = "scruffy/release";

/**
 * Outbox payload for a check-run effect. Persisted JSON is untrusted at the
 * boundary (heritage scar), so the dispatcher parses it through this schema
 * before acting.
 */
export const CheckRunPayload = z.object({
  subject: SubjectRevision,
  externalId: z.string().min(1),
  name: z.string().min(1),
  conclusion: z.enum(["success", "failure", "neutral"]),
  title: z.string().min(1),
  summary: z.string(),
});
export type CheckRunPayload = z.infer<typeof CheckRunPayload>;

/**
 * Map a poison decision to a check conclusion. Note: `indeterminate` is
 * `neutral`, never `failure` — abstention is not a block, it escalates to a
 * deeper gate. In shadow mode this check is not a required status.
 */
export function decisionToCheck(decision: PoisonDecision): {
  conclusion: CheckConclusion;
  title: string;
} {
  switch (decision.outcome) {
    case "block":
      return { conclusion: "failure", title: "Poison gate: blocked" };
    case "allow":
      return { conclusion: "success", title: "Poison gate: passed" };
    case "indeterminate":
      return { conclusion: "neutral", title: "Poison gate: abstained (escalated)" };
    default: {
      const _exhaustive: never = decision;
      return _exhaustive;
    }
  }
}

/**
 * The idempotency key of a nightly run's check.
 *
 * Shared so the gate's first post, the publication refresh, and lifecycle
 * reconciliation all address ONE check run on the reviewed candidate instead of
 * competing checks that each tell a partial story. Bound to the candidate sha, so
 * a later candidate gets its own check rather than overwriting history.
 */
export function nightlyCheckExternalId(repository: string, commitSha: string): string {
  return `nightly:${repository}:${commitSha}`;
}

/**
 * Summarize a nightly REPORT for its check run. Nightly NEVER blocks, so the
 * conclusion is always `neutral` — it is a report, not a required gate.
 *
 * The one thing this function must never do is call a run clean that was not
 * completely reviewed. A quiet analyzer that could not look produces the same
 * empty finding list as a genuinely clean range, so the title is driven by
 * coverage FIRST and finding counts second; the gaps are then named in the body.
 * Rendering from the durable report (rather than the in-flight decision) keeps the
 * check and the persisted truth in agreement by construction.
 */
export function nightlyToCheck(report: NightlyReport): {
  conclusion: CheckConclusion;
  title: string;
  summary: string;
} {
  const { surfaced, suppressed, proposals } = report.summary;
  const gaps = requiredCoverageGaps(report.coverage);

  // The SAME title formatter the refreshed morning check uses, with `openItems: null`
  // because no lifecycle exists yet at gate time. Sharing it is what stops the first
  // post and the morning refresh from describing one run in two different vocabularies.
  const title = nightlyReviewTitle({
    requiredCoverageComplete: report.requiredCoverageComplete,
    requiredGaps: gaps.length,
    surfaced,
    proposals,
    openItems: null,
  });

  const findingLines = report.findings
    .filter((f) => f.visibility === "surfaced")
    .map(
      (f) =>
        `- [${f.remediation?.state ?? "none"}] ${f.defectClass} at ${f.region.path}:${f.region.startLine} (${f.visibilityReason})`,
    );
  const gapLines = gaps.map(
    (g) => `- [coverage] ${g.analyzerId}: ${g.code} — ${g.detail || "no detail reported"}`,
  );

  const summary = [
    `surfaced: ${surfaced}, proposed fixes: ${proposals}, suppressed (audit only): ${suppressed}, required coverage gaps: ${gaps.length}.`,
    ...(findingLines.length ? ["", ...findingLines] : []),
    ...(gapLines.length
      ? [
          "",
          "Coverage was INCOMPLETE — this is not a clean bill of health, and the reviewed range is held open until every gap is closed:",
          ...gapLines,
        ]
      : []),
    ...(proposals > 0
      ? [
          "",
          "Proposed fixes open as pull requests for human review and are never auto-merged; a green CI run is not proof of correctness.",
        ]
      : []),
  ].join("\n");

  return { conclusion: "neutral", title, summary };
}

/**
 * Summarize a release REPORT for its check run. The check is rendered FROM the
 * persisted report — never from a separately-assembled decision — so the report,
 * the durable decision, and the advisory summary cannot disagree.
 *
 * SHADOW-FIRST: the conclusion is always `neutral` in the skeleton — the release
 * check is advisory and NEVER blocks publication yet. The true outcome
 * (ship | sign-off-required | stop) is recorded in the report and made loud in the
 * title, so nothing is hidden; promoting `stop` -> `failure` and wiring the
 * controlled draft-release protocol is the authoritative-mode follow-up (deferred,
 * ADR 0003 #1 spike territory).
 *
 * A concise summary intentionally omits bulky cleared evidence but preserves the
 * candidate, report id, outcome, coverage state, and every holding finding/gap.
 */
export function releaseToCheck(report: ReleaseRiskReport): {
  conclusion: CheckConclusion;
  title: string;
  summary: string;
} {
  const decision = report.decision;
  const { stopped, escalated, cleared, notRelevant } = decision.summary;
  const reviewed = stopped + escalated + cleared + notRelevant;

  // Retained model risks escalate but are NOT dispositions, so they are not in
  // `escalated`. Count them alongside findings so a sign-off driven purely by a
  // model risk is never rendered as "0 findings need human review".
  const riskCount = report.risks.length;

  // A lane holds the release when it is applicable but not clean. `complete` and
  // `not-applicable` are the only clean states; `partial`/`failed` are gaps. These
  // are what turns a zero-finding sign-off into an HONEST title — the actual reason
  // is missing/incomplete evidence, never "0 findings need human review".
  const incompleteLanes = report.evidenceLanes.filter(
    (lane) => lane.applicable && lane.status !== "complete" && lane.status !== "not-applicable",
  );
  // Coverage is clean only when EVERY applicable lane is complete. A ship over an
  // incomplete lane must never be titled "clean" (defence-in-depth: the decision
  // kernel already blocks ship on an incomplete required lane).
  const coverageClean = incompleteLanes.length === 0;

  let title: string;
  switch (decision.outcome) {
    case "stop":
      title = `Release gate: STOP (${stopped} confirmed blocker${stopped === 1 ? "" : "s"})`;
      break;
    case "sign-off-required": {
      // Name EVERY holding reason — findings, model risks, AND incomplete lanes —
      // so a coverage gap with zero findings shows the gap, not "0 findings".
      const holds: string[] = [];
      if (escalated > 0) holds.push(`${escalated} finding${escalated === 1 ? "" : "s"}`);
      if (riskCount > 0) holds.push(`${riskCount} model risk${riskCount === 1 ? "" : "s"}`);
      for (const lane of incompleteLanes) holds.push(`${lane.laneId} ${lane.status}`);
      const detail = holds.length > 0 ? holds.join(", ") : "incomplete evidence";
      title = `Release gate: sign-off required (${detail} — human review)`;
      break;
    }
    case "ship":
      // Only call it clean when coverage is actually clean. A reviewed-but-cleared
      // range says how many were reviewed; incomplete coverage is never "clean".
      title = coverageClean
        ? reviewed === 0
          ? "Release gate: ship (clean)"
          : `Release gate: ship (${reviewed} finding${reviewed === 1 ? "" : "s"} reviewed, none holding)`
        : `Release gate: ship (coverage incomplete)`;
      break;
    case "indeterminate":
      title = "Release gate: abstained (analysis failed)";
      break;
    default: {
      const _exhaustive: never = decision;
      return _exhaustive;
    }
  }

  const findingLines = decision.dispositions
    .filter((d) => d.effect === "stops" || d.effect === "escalates")
    .map(
      (d) =>
        `- [${d.effect}] ${d.defectClass} at ${d.region.path}:${d.region.startLine} (${d.reason})`,
    );
  // Coverage BEFORE finding totals: a clean count over incomplete coverage is not
  // a clean bill of health. Surface every lane's status and its explicit gaps.
  const laneLines = report.evidenceLanes.flatMap((lane) => [
    `- ${lane.laneId}: ${lane.status}` +
      (lane.required ? " (required)" : lane.applicable ? "" : " (not applicable)"),
    ...lane.gaps.map((g) => `    gap: ${g}`),
  ]);
  // A concise summary omits bulky cleared evidence but must preserve every
  // HOLDING model risk — a retained model risk is unresolved and forced sign-off,
  // so it can never be silently dropped from the advisory summary.
  const riskLines = report.risks.flatMap((r) => [
    `- [risk] ${r.category}: ${singleLine(r.scenario)}`,
    `    affected surface: ${singleLine(r.affectedSurface)}`,
    `    blast radius: ${singleLine(r.blastRadius ?? "not established by this report version")}`,
    `    impact: ${singleLine(r.impact)}`,
    `    detectability: ${singleLine(r.detectability ?? "not established")}`,
    `    reversibility: ${singleLine(r.reversibility ?? "not established")}`,
    `    rollback: ${singleLine(r.rollback ?? "not established")}`,
    `    uncertainty: ${singleLine(r.uncertainty ?? "none stated")}`,
    `    supporting evidence: ${singleLine(r.supportingEvidence?.join("; ") || "none stated")}`,
    `    contradicting evidence: ${singleLine(r.contradictingEvidence?.join("; ") || "none stated")}`,
    `    citations: ${singleLine(r.citations.map((c) => `${c.path}:${c.line}`).join(", "))}`,
  ]);
  const workLines = releaseWorkLines(report);
  const reasons = decision.reasons.length > 0 ? decision.reasons.join(", ") : "(none)";
  const summary = [
    `candidate: ${report.subject.candidateSha}`,
    `previous release: ${report.subject.previousReleaseSha ?? "(first release)"}`,
    `report: ${report.reportId} (v${report.reportVersion}, policy ${report.policyVersion})`,
    `outcome: ${decision.outcome} — reasons: ${reasons}.`,
    ...(decision.outcome === "sign-off-required"
      ? [
          "",
          "HUMAN RESPONSIBILITY — approval does not transfer responsibility to Scruffy:",
          signoffResponsibility(report),
        ]
      : []),
    "",
    // Coverage FIRST — before any finding total — so incomplete evidence can never
    // hide behind a clean-looking finding count.
    "coverage:",
    ...laneLines,
    ...(incompleteLanes.length
      ? ["", `holding gaps: ${incompleteLanes.map((l) => l.laneId).join(", ")} not complete.`]
      : []),
    "",
    `findings — stopped: ${stopped}, escalated: ${escalated}, cleared: ${cleared}, not-relevant: ${notRelevant}.`,
    ...(findingLines.length ? ["", ...findingLines] : []),
    ...(riskLines.length
      ? ["", `model risks — ${riskCount} unresolved (model-authored, advisory):`, ...riskLines]
      : []),
    ...(workLines.length ? ["", ...workLines] : []),
    "",
    "Shadow mode: this check is advisory and does not block publication.",
  ].join("\n");

  return { conclusion: "neutral", title, summary };
}

const CHECK_CONTEXT_ITEM_LIMIT = 10;

/** Concise view; the persisted report retains the complete bounded snapshot. */
function releaseWorkLines(report: ReleaseRiskReport): string[] {
  const work = report.outstandingWork;
  if (work === undefined) return [];

  const lines = [
    "outstanding work — CONTEXT ONLY; backlog state does not change the release outcome:",
    `- repository context: ${work.repository.status}; ${work.repository.bugIssues.length} open bug issue(s), ${work.repository.openPullRequests.length} open PR(s)`,
    ...work.repository.gaps.map((gap) => `    gap: ${singleLine(gap)}`),
  ];
  for (const issue of work.repository.bugIssues.slice(0, CHECK_CONTEXT_ITEM_LIMIT)) {
    lines.push(`    bug #${issue.number}: ${singleLine(issue.title)} — ${issue.url}`);
  }
  if (work.repository.bugIssues.length > CHECK_CONTEXT_ITEM_LIMIT) {
    lines.push(
      `    ... ${work.repository.bugIssues.length - CHECK_CONTEXT_ITEM_LIMIT} more bug issue(s) retained in the report`,
    );
  }

  if (work.repository.openPullRequests.length > 0) {
    lines.push("    open PR details collapsed: future work, not part of the release candidate");
  }

  lines.push(
    `- Scruffy nightly context: ${work.nightly.status}; ${work.nightly.reportsConsidered} report(s), ${work.nightly.findings.length} unresolved tracked finding(s)`,
  );
  for (const gap of work.nightly.gaps) lines.push(`    gap: ${singleLine(gap)}`);
  for (const finding of work.nightly.findings.slice(0, CHECK_CONTEXT_ITEM_LIMIT)) {
    lines.push(
      `    [${finding.resolution}] ${finding.defectClass} at ${finding.path}:${finding.startLine}` +
        (finding.issue ? ` — ${finding.issue.url}` : ""),
    );
  }
  if (work.nightly.findings.length > CHECK_CONTEXT_ITEM_LIMIT) {
    lines.push(
      `    ... ${work.nightly.findings.length - CHECK_CONTEXT_ITEM_LIMIT} more tracked finding(s) retained in the report`,
    );
  }
  return lines;
}

function singleLine(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 180);
}

export function toCheckRunInput(payload: CheckRunPayload): CheckRunInput {
  return {
    subject: payload.subject,
    externalId: payload.externalId,
    name: payload.name,
    conclusion: payload.conclusion,
    title: payload.title,
    summary: payload.summary,
  };
}
