import type { Finding } from "../../domain/evidence/types.js";
import type { ReleasePolicy } from "../../domain/policy/types.js";

/**
 * The release decision kernel: a pure function over immutable, already-validated
 * inputs. No IO, no clock, no randomness (same discipline as the poison and
 * nightly kernels).
 *
 * Contract (ADR 0003 / three-gate dossier):
 *   evaluateRelease(findings, policy) -> ship | sign-off-required | stop
 *   over the whole (prev-release, candidate] range.
 *
 * The release gate is the LAST gate before publication. Unlike poison — which
 * escalates its uncertainty to a deeper gate by abstaining (indeterminate) —
 * release has nowhere to escalate but a HUMAN. That single fact shapes the kernel:
 *
 *  1. `stop` is the strongest, blocking-est claim and is EARNED exactly like a
 *     poison block: the finding must be a stop-class defect, adversarially
 *     `validated`, carry deterministic support, AND have complete evidence. Raw
 *     model self-confidence can never stop a release.
 *  2. Anything dangerous we could NOT confirm or clear escalates to
 *     `sign-off-required` — never a silent ship (auto-shipping a possible
 *     catastrophe is the one thing the last gate must never do) and never a
 *     fabricated `stop` (we don't hard-block on a maybe).
 *  3. A refuted finding was cleared by the adversarial validator — it does not
 *     hold the release.
 *  4. `indeterminate` is NOT produced here. It is reserved for the service to
 *     record when the analysis machinery itself could not run (infra failure).
 *     The kernel always reaches ship/sign-off-required/stop over the findings it
 *     is given; the discriminated union carries `indeterminate` only so the
 *     decision *space* and the check mapping stay exhaustive.
 */

export type ReleaseOutcome = "ship" | "sign-off-required" | "stop" | "indeterminate";

/** Stable reason codes. Part of the audit contract; never free-form. */
export type ReleaseReasonCode =
  | "no_release_findings"
  | "stop_class_confirmed"
  | "stop_class_unconfirmed"
  | "signoff_class_confirmed"
  | "signoff_class_unconfirmed"
  | "finding_refuted"
  | "not_release_relevant";

/** How a single finding affected the release outcome. */
export type ReleaseEffect = "stops" | "escalates" | "cleared" | "not_relevant";

export interface ReleaseFindingDisposition {
  ruleId: string;
  defectClass: string;
  region: { path: string; startLine: number };
  effect: ReleaseEffect;
  reason: ReleaseReasonCode;
  /** Whether deterministic evidence backs this finding — surfaced for ranking/audit. */
  deterministicSupport: boolean;
}

export interface ReleaseSummary {
  stopped: number;
  escalated: number;
  cleared: number;
  notRelevant: number;
}

interface ReleaseDecisionBase {
  reasons: ReleaseReasonCode[];
  dispositions: ReleaseFindingDisposition[];
  summary: ReleaseSummary;
}

export type ReleaseDecision =
  | ({ outcome: "ship" } & ReleaseDecisionBase)
  | ({ outcome: "sign-off-required" } & ReleaseDecisionBase)
  | ({ outcome: "stop" } & ReleaseDecisionBase)
  | ({ outcome: "indeterminate" } & ReleaseDecisionBase);

function hasDeterministicSupport(finding: Finding): boolean {
  return finding.supporting.some((e) => e.trust === "deterministic");
}

/** A finding is CONFIRMED when it carries every ingredient a block/stop requires. */
function isConfirmed(finding: Finding): boolean {
  return (
    finding.validation === "validated" &&
    finding.completeness.requiredEvidencePresent &&
    hasDeterministicSupport(finding)
  );
}

function classify(finding: Finding, policy: ReleasePolicy): { effect: ReleaseEffect; reason: ReleaseReasonCode } {
  const isStop = policy.stopDefectClasses.includes(finding.defectClass);
  const isSignoff = policy.signoffDefectClasses.includes(finding.defectClass);

  if (!isStop && !isSignoff) {
    return { effect: "not_relevant", reason: "not_release_relevant" };
  }

  // The adversarial validator found independent evidence against it — cleared.
  if (finding.validation === "refuted") {
    return { effect: "cleared", reason: "finding_refuted" };
  }

  // Stop class wins over sign-off class if a class were in both lists.
  if (isStop) {
    if (isConfirmed(finding)) return { effect: "stops", reason: "stop_class_confirmed" };
    // Dangerous but not confirmed: escalate to a human, never fabricate a stop.
    return { effect: "escalates", reason: "stop_class_unconfirmed" };
  }

  // Sign-off class: any surfaced (non-refuted) finding forces human sign-off. The
  // reason distinguishes confirmed from couldn't-confirm for the audit trail; both
  // escalate because release cannot auto-accept a serious regression.
  if (isConfirmed(finding)) return { effect: "escalates", reason: "signoff_class_confirmed" };
  return { effect: "escalates", reason: "signoff_class_unconfirmed" };
}

const EFFECT_PRIORITY: Record<ReleaseEffect, number> = {
  stops: 0,
  escalates: 1,
  cleared: 2,
  not_relevant: 3,
};

export function evaluateRelease(findings: readonly Finding[], policy: ReleasePolicy): ReleaseDecision {
  const dispositions: ReleaseFindingDisposition[] = findings.map((finding) => {
    const { effect, reason } = classify(finding, policy);
    return {
      ruleId: finding.ruleId,
      defectClass: finding.defectClass,
      region: { path: finding.primaryRegion.path, startLine: finding.primaryRegion.startLine },
      effect,
      reason,
      deterministicSupport: hasDeterministicSupport(finding),
    };
  });

  // Ranked most-severe first, then a fully deterministic tiebreak so the ordering
  // is reproducible on replay (no clock, no analyzer emission order).
  dispositions.sort((a, b) => {
    const byEffect = EFFECT_PRIORITY[a.effect] - EFFECT_PRIORITY[b.effect];
    if (byEffect !== 0) return byEffect;
    const bySupport = Number(b.deterministicSupport) - Number(a.deterministicSupport);
    if (bySupport !== 0) return bySupport;
    return (
      a.defectClass.localeCompare(b.defectClass) ||
      a.region.path.localeCompare(b.region.path) ||
      a.region.startLine - b.region.startLine ||
      a.ruleId.localeCompare(b.ruleId)
    );
  });

  const summary = summarize(dispositions);

  const stops = dispositions.filter((d) => d.effect === "stops");
  if (stops.length > 0) {
    return { outcome: "stop", reasons: dedupe(stops.map((d) => d.reason)), dispositions, summary };
  }

  const escalations = dispositions.filter((d) => d.effect === "escalates");
  if (escalations.length > 0) {
    return {
      outcome: "sign-off-required",
      reasons: dedupe(escalations.map((d) => d.reason)),
      dispositions,
      summary,
    };
  }

  // Ship: nothing stops or escalates. Reasons reflect why each candidate cleared
  // (refuted vs never relevant); empty range ships with `no_release_findings`.
  const shipReasons = dedupe(dispositions.map((d) => d.reason));
  return {
    outcome: "ship",
    reasons: shipReasons.length > 0 ? shipReasons : ["no_release_findings"],
    dispositions,
    summary,
  };
}

/** Recompute the effect counts. Exported for the check-run summary and tests. */
export function summarize(dispositions: readonly ReleaseFindingDisposition[]): ReleaseSummary {
  return {
    stopped: dispositions.filter((d) => d.effect === "stops").length,
    escalated: dispositions.filter((d) => d.effect === "escalates").length,
    cleared: dispositions.filter((d) => d.effect === "cleared").length,
    notRelevant: dispositions.filter((d) => d.effect === "not_relevant").length,
  };
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}
