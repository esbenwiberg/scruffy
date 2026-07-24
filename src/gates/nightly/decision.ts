import type { Finding } from "../../domain/evidence/types.js";
import type { NightlyPolicy } from "../../domain/policy/types.js";

/**
 * The nightly decision kernel: a pure function over immutable, already-validated
 * inputs. No IO, no clock, no randomness (same discipline as the poison kernel).
 *
 * Contract (ADR 0003 / three-gate dossier):
 *   evaluateNightly(findings, policy) -> per-finding { suppress | report | propose_fix }
 *
 * Unlike poison, nightly never returns ONE outcome for the subject — it never
 * blocks. It classifies each finding into a disposition. Safety stance:
 *  1. `propose_fix` is the strongest claim and is earned, never assumed: the
 *     finding must be a fixable class, adversarially `validated`, AND carry
 *     deterministic support. A model verdict alone cannot escalate to a fix.
 *  2. A refuted finding is suppressed — the adversarial validator cleared it.
 *  3. Anything reportable that we could NOT clear or confirm is still `report`
 *     (surfaced for a human), never silently dropped and never auto-fixed.
 *  4. A class the policy does not consider reportable is suppressed: recorded,
 *     but not surfaced. A fixable class is ALWAYS considered reportable — the
 *     fixable list need not repeat entries in the reportable list — so a class
 *     configured only as fixable is never suppressed by the reportable gate
 *     before it can earn a `propose_fix`.
 */

export type NightlyDispositionKind = "suppress" | "report" | "propose_fix";

/** Stable reason codes. Part of the audit contract; never free-form. */
export type NightlyReasonCode =
  | "not_reportable_class"
  | "refuted"
  | "fixable_validated"
  | "reportable_validated"
  | "reportable_unvalidated"
  | "fix_unavailable";

export interface NightlyFindingDisposition {
  ruleId: string;
  defectClass: string;
  region: { path: string; startLine: number };
  disposition: NightlyDispositionKind;
  reason: NightlyReasonCode;
  /** Whether deterministic evidence backs this finding — surfaced for ranking/audit. */
  deterministicSupport: boolean;
}

export interface NightlyDecision {
  /** One entry per finding, ranked most-actionable first. */
  dispositions: NightlyFindingDisposition[];
  summary: { reported: number; proposedFixes: number; suppressed: number };
}

function hasDeterministicSupport(finding: Finding): boolean {
  return finding.supporting.some((e) => e.trust === "deterministic");
}

function classify(
  finding: Finding,
  policy: NightlyPolicy,
): { disposition: NightlyDispositionKind; reason: NightlyReasonCode } {
  // A fixable class implies reportability: the documented propose_fix contract
  // (fixable + validated + deterministic) says nothing about the reportable list,
  // so a class configured only as fixable must not be suppressed here before it
  // can reach the fixable branch below.
  const reportable =
    policy.reportableDefectClasses.includes(finding.defectClass) ||
    policy.fixableDefectClasses.includes(finding.defectClass);
  if (!reportable) {
    return { disposition: "suppress", reason: "not_reportable_class" };
  }

  // The adversarial validator found independent evidence against it — drop it.
  if (finding.validation === "refuted") {
    return { disposition: "suppress", reason: "refuted" };
  }

  const fixable =
    policy.fixableDefectClasses.includes(finding.defectClass) &&
    finding.validation === "validated" &&
    hasDeterministicSupport(finding);
  if (fixable) {
    return { disposition: "propose_fix", reason: "fixable_validated" };
  }

  // Everything else surfaces for a human. Confirmed-but-not-fixable and
  // couldn't-confirm are distinguished only by reason code, not by whether we
  // report — nightly reports both, it just won't auto-fix the latter.
  if (finding.validation === "validated") {
    return { disposition: "report", reason: "reportable_validated" };
  }
  return { disposition: "report", reason: "reportable_unvalidated" };
}

const DISPOSITION_PRIORITY: Record<NightlyDispositionKind, number> = {
  propose_fix: 0,
  report: 1,
  suppress: 2,
};

export function evaluateNightly(findings: readonly Finding[], policy: NightlyPolicy): NightlyDecision {
  const dispositions: NightlyFindingDisposition[] = findings.map((finding) => {
    const { disposition, reason } = classify(finding, policy);
    return {
      ruleId: finding.ruleId,
      defectClass: finding.defectClass,
      region: { path: finding.primaryRegion.path, startLine: finding.primaryRegion.startLine },
      disposition,
      reason,
      deterministicSupport: hasDeterministicSupport(finding),
    };
  });

  return { dispositions: rankDispositions(dispositions), summary: summarize(dispositions) };
}

/**
 * Rank dispositions most-actionable first, then a fully deterministic tiebreak so
 * the ordering is reproducible on replay (no clock, no analyzer emission order).
 * Sorts in place and returns the same array. Exported so fix generation can
 * re-rank after downgrading a propose_fix it could not patch — otherwise a
 * downgraded `report` keeps its former propose_fix position ahead of genuine
 * propose_fix entries, breaking the "ranked most-actionable first" contract.
 */
export function rankDispositions(dispositions: NightlyFindingDisposition[]): NightlyFindingDisposition[] {
  return dispositions.sort((a, b) => {
    const byDisposition = DISPOSITION_PRIORITY[a.disposition] - DISPOSITION_PRIORITY[b.disposition];
    if (byDisposition !== 0) return byDisposition;
    const bySupport = Number(b.deterministicSupport) - Number(a.deterministicSupport);
    if (bySupport !== 0) return bySupport;
    return (
      a.defectClass.localeCompare(b.defectClass) ||
      a.region.path.localeCompare(b.region.path) ||
      a.region.startLine - b.region.startLine ||
      a.ruleId.localeCompare(b.ruleId)
    );
  });
}

/** Recompute the disposition counts. Exported so fix generation can re-summarize
 * after downgrading a propose_fix it could not actually patch. */
export function summarize(dispositions: readonly NightlyFindingDisposition[]): NightlyDecision["summary"] {
  return {
    reported: dispositions.filter((d) => d.disposition === "report").length,
    proposedFixes: dispositions.filter((d) => d.disposition === "propose_fix").length,
    suppressed: dispositions.filter((d) => d.disposition === "suppress").length,
  };
}
