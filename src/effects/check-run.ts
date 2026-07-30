import { z } from "zod";
import { SubjectRevision } from "../domain/evidence/types.js";
import type { CheckConclusion, CheckRunInput } from "../providers/scm/port.js";
import type { PoisonDecision } from "../gates/poison/decision.js";
import type { ReleaseDecision } from "../gates/release/decision.js";
import { requiredCoverageGaps, type NightlyReport } from "../domain/findings/work-graph.js";

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
export function decisionToCheck(decision: PoisonDecision): { conclusion: CheckConclusion; title: string } {
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

export function nightlyToCheck(report: NightlyReport): { conclusion: CheckConclusion; title: string; summary: string } {
  const { surfaced, suppressed, proposals } = report.summary;
  const gaps = requiredCoverageGaps(report.coverage);
  const fixes = proposals > 0 ? ` (${proposals} fix${proposals === 1 ? "" : "es"} proposed)` : "";

  const title = !report.requiredCoverageComplete
    ? `Nightly review: INCOMPLETE — ${gaps.length} coverage gap${gaps.length === 1 ? "" : "s"}, ` +
      `${surfaced} finding${surfaced === 1 ? "" : "s"}${fixes}`
    : surfaced === 0
      ? "Nightly review: clean"
      : `Nightly review: ${surfaced} finding${surfaced === 1 ? "" : "s"}${fixes}`;

  const findingLines = report.findings
    .filter((f) => f.visibility === "surfaced")
    .map(
      (f) =>
        `- [${f.remediation?.state ?? "none"}] ${f.defectClass} at ${f.region.path}:${f.region.startLine} (${f.visibilityReason})`,
    );
  const gapLines = gaps.map((g) => `- [coverage] ${g.analyzerId}: ${g.code} — ${g.detail || "no detail reported"}`);

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
      ? ["", "Proposed fixes open as pull requests for human review and are never auto-merged; a green CI run is not proof of correctness."]
      : []),
  ].join("\n");

  return { conclusion: "neutral", title, summary };
}

/**
 * Summarize a release decision for its check run. SHADOW-FIRST: the conclusion is
 * always `neutral` in the skeleton — the release check is advisory and NEVER
 * blocks publication yet. The true outcome (ship | sign-off-required | stop) is
 * recorded in the decision and made loud in the title, so nothing is hidden;
 * promoting `stop` -> `failure` and wiring the controlled draft-release protocol
 * is the authoritative-mode follow-up (deferred, ADR 0003 #1 spike territory).
 */
export function releaseToCheck(decision: ReleaseDecision): { conclusion: CheckConclusion; title: string; summary: string } {
  const { stopped, escalated, cleared, notRelevant } = decision.summary;
  const reviewed = stopped + escalated + cleared + notRelevant;

  let title: string;
  switch (decision.outcome) {
    case "stop":
      title = `Release gate: STOP (${stopped} confirmed blocker${stopped === 1 ? "" : "s"})`;
      break;
    case "sign-off-required":
      title = `Release gate: sign-off required (${escalated} finding${escalated === 1 ? "" : "s"} need human review)`;
      break;
    case "ship":
      title = reviewed === 0 ? "Release gate: ship (clean)" : `Release gate: ship (${reviewed} finding${reviewed === 1 ? "" : "s"} reviewed, none holding)`;
      break;
    case "indeterminate":
      title = "Release gate: abstained (analysis failed)";
      break;
    default: {
      const _exhaustive: never = decision;
      return _exhaustive;
    }
  }

  const lines = decision.dispositions
    .filter((d) => d.effect === "stops" || d.effect === "escalates")
    .map((d) => `- [${d.effect}] ${d.defectClass} at ${d.region.path}:${d.region.startLine} (${d.reason})`);
  const summary = [
    `outcome: ${decision.outcome}. stopped: ${stopped}, escalated: ${escalated}, cleared: ${cleared}, not-relevant: ${notRelevant}.`,
    ...(lines.length ? ["", ...lines] : []),
    "",
    "Shadow mode: this check is advisory and does not block publication.",
  ].join("\n");

  return { conclusion: "neutral", title, summary };
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
