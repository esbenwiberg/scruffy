import type { Finding } from "../../domain/evidence/types.js";
import type { ProposedFix } from "../../domain/fixes/types.js";
import { findingKey } from "../../domain/findings/identity.js";
import { fixProposalBranch, type FixDeliveryReadiness, type PreconditionedEdit } from "../../domain/fixes/delivery.js";
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
  type RemediationProvenance,
} from "../../domain/findings/work-identity.js";
import type { NightlyDecision } from "./decision.js";
import type { RemediationAttempt } from "./remediation.js";

/**
 * Project the pure nightly decision (plus whatever remediation was actually
 * attempted) onto the durable report shape. This is the ONLY place the gate's
 * single disposition axis is split into the report's independent axes, so the
 * mapping is stated once and can be read in one screen:
 *
 *   suppress      -> suppressed, no remediation record at all (audit only)
 *   surfaced, no attempt
 *                 -> remediation `pending` — an attempt is OWED. "No patch yet" is
 *                    not "no fix needed", and it is certainly not "not a real
 *                    finding".
 *   surfaced, attempted
 *                 -> the attempt's own outcome, mapped below. Every surviving
 *                    finding earns exactly one attempt, deterministic or model.
 *
 * A proposal's BRANCH is derived here from the full fix-proposal identity rather
 * than from its location, so the delivery path can never confuse tonight's patch
 * for `src/a.ts:42` with last month's patch for the same line.
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
  /**
   * Deterministic fixes from the legacy `generateFixes` path. Still honoured so a
   * caller that has not moved to the remediation boundary keeps working; where
   * both are supplied, `attempts` wins because it is the richer statement.
   */
  fixes?: readonly ProposedFix[];
  /** Remediation attempts by finding key (see `attemptRemediations`). */
  attempts?: ReadonlyMap<string, RemediationAttempt>;
}): NightlyReport {
  const { identity, decision } = params;
  const reportId = nightlyReportId(identity);
  const findingByKey = new Map(params.findings.map((f) => [findingKey(f), f]));
  const fixByKey = new Map((params.fixes ?? []).map((f) => [f.findingKey, f]));
  const attempts = params.attempts ?? new Map<string, RemediationAttempt>();

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
        d.disposition === "suppress"
          ? null
          : remediationFor({
              identity,
              findingKey: d.findingKey,
              occurrenceId,
              defectClass: d.defectClass,
              reason: d.reason,
              attempt: attempts.get(d.findingKey),
              fix: fixByKey.get(d.findingKey),
            }),
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

interface RemediationInput {
  identity: NightlyReportIdentity;
  findingKey: string;
  occurrenceId: string;
  defectClass: string;
  reason: NightlyDecision["dispositions"][number]["reason"];
  attempt: RemediationAttempt | undefined;
  fix: ProposedFix | undefined;
}

/**
 * Map one finding's remediation attempt onto the durable, coarse record.
 *
 * The attempt vocabulary is deliberately richer than what is persisted (it
 * distinguishes twelve reason codes; the record keeps five states). The rich code
 * is not discarded — it rides along on the proposal as `validationReason`, and it
 * is what the PR body shows a reviewer. What the record must get right is the
 * COARSE truth a human decision hangs off: is there a patch, was one refused, or
 * did the attempt come back empty-handed?
 */
function remediationFor(input: RemediationInput): RemediationRecord {
  const { attempt } = input;

  if (attempt !== undefined) {
    switch (attempt.outcome) {
      case "ready":
      case "draft": {
        // Defensive: `edits`/`provenance` are non-null for these outcomes by
        // construction, but a proposal is the one thing we must never fabricate.
        if (attempt.edits === null || attempt.edits.length === 0 || attempt.provenance === null) {
          return { state: "failed", reason: "attempt_failed", proposal: null };
        }
        return {
          state: "proposed",
          reason: attempt.reasonCode === "deterministic_patch_ready" ? "deterministic_patch_ready" : "model_patch_proposed",
          proposal: proposalFor({
            identity: input.identity,
            findingKey: input.findingKey,
            occurrenceId: input.occurrenceId,
            defectClass: input.defectClass,
            provenance: attempt.provenance,
            edits: attempt.edits,
            readiness: attempt.outcome,
            validationReason: attempt.reasonCode,
          }),
        };
      }
      // Something WAS produced and the service refused it. The finding stays fully
      // actionable, with the refusal reason on the record.
      case "rejected":
        return { state: "failed", reason: "patch_refused", proposal: null };
      case "unavailable":
        // A provider that fell over is not the same fact as "nothing to fix here",
        // and collapsing them would let an outage read as an absence of options.
        return attempt.reasonCode === "model_provider_failed" ||
          attempt.reasonCode === "model_unparseable" ||
          attempt.reasonCode === "no_source_context"
          ? { state: "failed", reason: "attempt_failed", proposal: null }
          : { state: "unavailable", reason: "fixer_declined", proposal: null };
      default: {
        const _exhaustive: never = attempt.outcome;
        return _exhaustive;
      }
    }
  }

  if (input.fix !== undefined) {
    const provenance = deterministicFixerProvenance(input.fix.defectClass);
    return {
      state: "proposed",
      reason: "deterministic_patch_ready",
      proposal: proposalFor({
        identity: input.identity,
        findingKey: input.findingKey,
        occurrenceId: input.occurrenceId,
        defectClass: input.defectClass,
        provenance,
        edits: input.fix.edits,
        readiness: "ready",
        validationReason: "deterministic_patch_ready",
      }),
    };
  }
  if (input.reason === "fix_unavailable") {
    return { state: "unavailable", reason: "fixer_declined", proposal: null };
  }
  return { state: "pending", reason: "attempt_owed", proposal: null };
}

function proposalFor(input: {
  identity: NightlyReportIdentity;
  findingKey: string;
  occurrenceId: string;
  defectClass: string;
  provenance: RemediationProvenance;
  edits: readonly PreconditionedEdit[];
  readiness: FixDeliveryReadiness;
  validationReason: string;
}): FixProposalRecord {
  const proposalId = fixProposalId({
    occurrence: { report: input.identity, findingKey: input.findingKey },
    provenance: input.provenance,
  });
  return {
    proposalId,
    occurrenceId: input.occurrenceId,
    provenance: input.provenance,
    // CANDIDATE-BOUND. Derived from the proposal identity (which carries the
    // reviewed head sha and the fixer versions), never from the defect location —
    // that is what stops a later candidate's patch from colliding with an older,
    // possibly human-closed pull request on the same line.
    branch: fixProposalBranch({ proposalId, defectClass: input.defectClass, headSha: input.identity.headSha }),
    edits: [...input.edits],
    readiness: input.readiness,
    validationReason: input.validationReason,
    delivery: "queued",
    ci: "unknown",
    merge: "open",
  };
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
