import type { Finding } from "../../domain/evidence/types.js";
import type { ProposedFix } from "../../domain/fixes/types.js";
import { findingKey } from "../../domain/findings/identity.js";
import {
  NightlyReport,
  summarizeReportFindings,
  requiredCoverageGaps,
  type FixProposalRecord,
  type NightlyReportFinding,
  type RemediationRecord,
} from "../../domain/findings/work-graph.js";
import {
  deterministicFixerProvenance,
  findingOccurrenceId,
  fixProposalId,
  nightlyReportId,
  type NightlyReportIdentity,
} from "../../domain/findings/work-identity.js";
import type { NightlyDecision } from "./decision.js";

/**
 * Project the pure nightly decision (plus whatever fixes were actually generated)
 * onto the durable report shape. This is the ONLY place the gate's single
 * disposition axis is split into the report's independent axes, so the mapping is
 * stated once and can be read in one screen:
 *
 *   suppress      -> suppressed, no remediation record at all (audit only)
 *   report        -> surfaced, remediation `pending` — an attempt is OWED. This is
 *                    the shape brief 03 needs: "no patch yet" is not "no fix
 *                    needed", and it is certainly not "not a real finding".
 *   report/
 *   fix_unavailable-> surfaced, remediation `unavailable` (a registered fixer
 *                    declined; the finding stays actionable for a human)
 *   propose_fix   -> surfaced, remediation `proposed` with the concrete patch
 *
 * Pure: no IO, no clock. The report is parsed through its own schema before it is
 * returned, so an internally inconsistent report (a summary that disagrees with
 * its findings, a completeness that disagrees with its coverage) fails HERE rather
 * than being persisted and later believed.
 */
export function buildNightlyReport(params: {
  identity: NightlyReportIdentity;
  findings: readonly Finding[];
  /** The decision AFTER fix generation, so downgrades are already applied. */
  decision: NightlyDecision;
  fixes: readonly ProposedFix[];
}): NightlyReport {
  const { identity, decision } = params;
  const reportId = nightlyReportId(identity);
  const findingByKey = new Map(params.findings.map((f) => [findingKey(f), f]));
  const fixByKey = new Map(params.fixes.map((f) => [f.findingKey, f]));

  const findings: NightlyReportFinding[] = decision.dispositions.map((d) => {
    const finding = findingByKey.get(d.findingKey);
    const occurrenceId = findingOccurrenceId({ report: identity, findingKey: d.findingKey });
    const region = {
      path: d.region.path,
      startLine: d.region.startLine,
      // Fall back to the disposition's single line only if the finding is somehow
      // absent; never invent a wider region than we were told about.
      endLine: finding?.primaryRegion.endLine ?? d.region.startLine,
    };
    return {
      occurrenceId,
      findingKey: d.findingKey,
      ruleId: d.ruleId,
      defectClass: d.defectClass,
      region,
      validation: finding?.validation ?? "not_requested",
      deterministicSupport: d.deterministicSupport,
      visibility: d.disposition === "suppress" ? "suppressed" : "surfaced",
      visibilityReason: d.reason,
      resolution: "open",
      remediation:
        d.disposition === "suppress" ? null : remediationFor(identity, d.findingKey, occurrenceId, d.reason, fixByKey.get(d.findingKey)),
    };
  });

  const gaps = requiredCoverageGaps(decision.coverage);
  return NightlyReport.parse({
    reportId,
    identity,
    coverage: decision.coverage,
    requiredCoverageComplete: gaps.length === 0,
    findings,
    summary: summarizeReportFindings(findings, gaps.length),
  });
}

function remediationFor(
  identity: NightlyReportIdentity,
  key: string,
  occurrenceId: string,
  reason: NightlyDecision["dispositions"][number]["reason"],
  fix: ProposedFix | undefined,
): RemediationRecord {
  if (fix !== undefined) {
    const provenance = deterministicFixerProvenance(fix.defectClass);
    const proposal: FixProposalRecord = {
      proposalId: fixProposalId({ occurrence: { report: identity, findingKey: key }, provenance }),
      occurrenceId,
      provenance,
      // The delivery key for THIS slice is the fix branch the effect already uses.
      // Binding the branch itself to the proposal identity is brief 04's job (it
      // owns PR publication); the identity above is already candidate-bound, so
      // nothing downstream has to trust the branch slug for identity.
      branch: fix.branch,
      edits: fix.edits,
      delivery: "queued",
      ci: "unknown",
      merge: "open",
    };
    return { state: "proposed", reason: "deterministic_patch_ready", proposal };
  }
  if (reason === "fix_unavailable") {
    return { state: "unavailable", reason: "fixer_declined", proposal: null };
  }
  return { state: "pending", reason: "attempt_owed", proposal: null };
}

/**
 * The report for a run whose analysis never completed. It reviewed nothing, so it
 * claims nothing: no findings, and coverage carrying the whole-analysis gap. The
 * planner then produces a parent plus one coverage-gap child, which is the point —
 * an abstained night is VISIBLE work, not an absence of news.
 */
export function abstainedNightlyReport(identity: NightlyReportIdentity, decision: NightlyDecision): NightlyReport {
  return buildNightlyReport({ identity, findings: [], decision, fixes: [] });
}
