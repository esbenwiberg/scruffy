import type { Finding } from "../../domain/evidence/types.js";
import type { AnalysisCoverage } from "../../domain/evidence/coverage.js";
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
 *  4. SHIP REQUIRES COMPLETE COVERAGE. An analyzer that could not run yields no
 *     findings, which looks exactly like a clean range. At the last gate before
 *     publication that reading is unacceptable, so an incomplete analysis
 *     escalates to `sign-off-required`: a human decides whether to ship
 *     un-reviewed code. It escalates rather than stopping because a gap is not
 *     evidence of a defect — and it never softens a `stop`.
 *  5. `indeterminate` is NOT produced here. It is reserved for the service to
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
  | "not_release_relevant"
  | "analysis_incomplete"
  // A retained range-level model risk. Every model risk is unresolved and
  // model-asserted, so it ESCALATES to human sign-off and can never stop.
  | "model_risk_present"
  // The release-risk LLM lane did not review the whole range (provider failure,
  // unparseable output, truncation, or an output cap). An incomplete required
  // lane escalates — the same "blind is not clean" rule the coverage gap applies.
  | "llm_lane_incomplete";

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
  /** What the analyzers actually managed to review. Carried for the audit trail. */
  coverage: AnalysisCoverage;
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

/**
 * The range-level LLM lane's contribution to the decision, when a release-risk
 * analyst is wired. Deliberately NARROW — the kernel never reads a model's prose,
 * only two facts derived from it upstream:
 *  - `retainedRiskCount`: how many citation-anchored, model-asserted risks
 *    survived. Each is unresolved, so any of them forces `sign-off-required`. A
 *    model risk NEVER manufactures `stop` (there is no LLM stop path).
 *  - `complete`: whether the analyst reviewed the whole bounded range. An
 *    incomplete lane escalates, exactly like an incomplete deterministic
 *    analysis — blind is not clean.
 *
 * Absent (undefined) means no analyst was wired for this run; the kernel then
 * behaves exactly as before (source-analysis coverage only). Slice 03 owns
 * declaring the lane REQUIRED in policy; this slice only lets its evidence
 * escalate when present.
 */
export interface ReleaseLlmLane {
  retainedRiskCount: number;
  complete: boolean;
}

/** `coverage` is required for the same reason it is on evaluatePoison — a
 * defaulted argument would make a blind run look like a clean one. */
export function evaluateRelease(
  findings: readonly Finding[],
  policy: ReleasePolicy,
  coverage: AnalysisCoverage,
  llm?: ReleaseLlmLane,
): ReleaseDecision {
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
    // A coverage gap — deterministic OR the LLM lane's risk/incompleteness —
    // cannot soften a confirmed deterministic stop. Stop wins, full stop.
    return { outcome: "stop", reasons: dedupe(stops.map((d) => d.reason)), dispositions, summary, coverage };
  }

  const modelRisk = (llm?.retainedRiskCount ?? 0) > 0;
  const llmIncomplete = llm !== undefined && !llm.complete;
  const escalations = dispositions.filter((d) => d.effect === "escalates");
  if (escalations.length > 0 || !coverage.complete || modelRisk || llmIncomplete) {
    // An incomplete analysis, OR a retained model risk, escalates on its own:
    // shipping code we never fully reviewed — or that a model flagged — is a
    // human's call to make, not ours. A model risk escalates but never stops.
    const reasons = dedupe(escalations.map((d) => d.reason));
    if (!coverage.complete) reasons.push("analysis_incomplete");
    if (modelRisk) reasons.push("model_risk_present");
    if (llmIncomplete) reasons.push("llm_lane_incomplete");
    return { outcome: "sign-off-required", reasons, dispositions, summary, coverage };
  }

  // Ship: nothing stops or escalates, and we reviewed the whole range. Reasons
  // reflect why each candidate cleared (refuted vs never relevant); an empty
  // range ships with `no_release_findings`.
  const shipReasons = dedupe(dispositions.map((d) => d.reason));
  return {
    outcome: "ship",
    reasons: shipReasons.length > 0 ? shipReasons : ["no_release_findings"],
    dispositions,
    summary,
    coverage,
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
