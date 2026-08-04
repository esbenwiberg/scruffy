import type { Finding } from "../../domain/evidence/types.js";
import type { AnalysisCoverage } from "../../domain/evidence/coverage.js";
import type { ReleasePolicy } from "../../domain/policy/types.js";
import type { ReleaseAuthorityAssessment } from "../../domain/release/authority-change.js";
import type { RequiredWorkflowAggregate } from "../../domain/release/required-workflow-evidence.js";

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
  | "llm_lane_incomplete"
  // A required candidate-CI lane is incomplete: a policy-named check/status context
  // was missing, non-success, wrong-SHA, or ambiguous for the exact candidate. An
  // incomplete required lane escalates — never a silent ship, never a fabricated stop.
  | "ci_lane_incomplete"
  // --- Workflow-prerequisite reason codes (kept in parity with report.ts) ---------
  // A configured required workflow completed with a terminal non-success conclusion.
  // A completed failure is an observed result a responsible human may sign off.
  | "required_workflow_failed"
  // First adoption / no readable previous configuration: a mandatory baseline sign-off.
  | "release_authority_baseline_required"
  // Repository release configuration or `.github` workflow/action authority changed
  // across the range: a mandatory sign-off even when current runs are green.
  | "release_authority_changed"
  // A required workflow is still pending/queued/in-progress. Not an approvable result;
  // it is retryable and must never enter the approval Environment early.
  | "required_workflow_pending"
  // No matching run for the exact configured workflow/candidate. Fail closed — a
  // missing run is not a failure a human may accept.
  | "required_workflow_absent"
  // A workflow's evidence could not be verified (provider fault / ambiguity / malformed
  // identity). Indeterminate — an outage must never be mistaken for a failure.
  | "required_workflow_unverifiable"
  // The candidate repository release configuration is absent or empty. Authorization-
  // ineligible: you cannot approve what you cannot read.
  | "release_config_missing"
  // The candidate repository release configuration is malformed / self-referential /
  // unsupported. Authorization-ineligible, never an approvable workflow failure.
  | "release_config_invalid";

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

/**
 * The candidate-CI lane's contribution to the decision. Also deliberately narrow:
 * the kernel never reads raw check/status records, only two policy-derived facts:
 *  - `required`: whether the lane is a `ship` precondition for this policy;
 *  - `complete`: whether every policy-named required context passed unambiguously
 *    for the exact candidate (a `not-applicable` lane is complete and never holds).
 *
 * A required, incomplete lane escalates to `sign-off-required` — a missing or
 * non-success required check is blind, and blind is not clean. Like every other
 * gap it can NEVER soften a confirmed deterministic stop.
 */
export interface ReleaseCiLane {
  required: boolean;
  complete: boolean;
}

/**
 * The workflow-prerequisite lane's contribution to the decision. This is the
 * repository-owned release-prerequisite contract, resolved from the release-authority
 * assessment and the required-workflow aggregate (see `derivePrerequisiteState`). It
 * is deliberately reduced to three service-owned kinds:
 *  - `satisfied`: every configured workflow passed AND authority is unchanged — the
 *    normal Scruffy decision proceeds untouched.
 *  - `sign-off`: an OBSERVED result a responsible human may accept — a terminal
 *    workflow failure, a first-adoption baseline, or an authority change (even when
 *    the current runs are green). It escalates like any other required-lane gap.
 *  - `not-approvable`: evidence that is NOT a result and cannot be converted into
 *    approval merely by asking — pending, absent, unverifiable, or an ineligible
 *    configuration. It fails closed to `indeterminate`.
 *
 * Absent (undefined) means no prerequisite contract was resolved for this run (the
 * local/corpus context-based candidate-CI path); the kernel then behaves exactly as
 * before. A `stop` always dominates every prerequisite state — see `evaluateRelease`.
 */
export type ReleasePrerequisiteState =
  | { kind: "satisfied" }
  | { kind: "sign-off"; reasons: ReleaseReasonCode[] }
  | { kind: "not-approvable"; reasons: ReleaseReasonCode[] };

/**
 * Derive the prerequisite contribution from the pure release-authority assessment and
 * the required-workflow aggregate. Conservative precedence, most-blocking first:
 *
 *  1. an INELIGIBLE candidate configuration (missing / malformed) → not-approvable;
 *  2. a `fail-closed` aggregate (a workflow absent or unverifiable) → not-approvable;
 *  3. a `not-ready` aggregate (a workflow still pending) → not-approvable;
 *  4. an `exception-eligible` aggregate (a terminal workflow failure) → sign-off;
 *  5. an authority `sign-off-required` (baseline or change) → sign-off;
 *  6. otherwise (all passed AND authority clean) → satisfied.
 *
 * Missing/unverifiable evidence (1–3) dominates the sign-off routes (4–5): you can
 * neither approve nor even establish the prerequisite yet. When BOTH a terminal
 * workflow failure and an authority change hold, both reasons are surfaced.
 */
export function derivePrerequisiteState(
  authority: ReleaseAuthorityAssessment,
  aggregate: RequiredWorkflowAggregate,
): ReleasePrerequisiteState {
  if (authority.outcome === "ineligible") {
    return { kind: "not-approvable", reasons: [authority.reasonCode as ReleaseReasonCode] };
  }
  if (aggregate.outcome === "fail-closed" || aggregate.outcome === "not-ready") {
    return { kind: "not-approvable", reasons: [aggregate.reasonCode as ReleaseReasonCode] };
  }

  const reasons: ReleaseReasonCode[] = [];
  if (aggregate.outcome === "exception-eligible") reasons.push("required_workflow_failed");
  if (authority.outcome === "sign-off-required") {
    reasons.push(authority.reasonCode as ReleaseReasonCode);
  }
  if (reasons.length > 0) return { kind: "sign-off", reasons };
  return { kind: "satisfied" };
}

/** `coverage` is required for the same reason it is on evaluatePoison — a
 * defaulted argument would make a blind run look like a clean one. */
export function evaluateRelease(
  findings: readonly Finding[],
  policy: ReleasePolicy,
  coverage: AnalysisCoverage,
  llm?: ReleaseLlmLane,
  ci?: ReleaseCiLane,
  prerequisite?: ReleasePrerequisiteState,
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
    // A coverage gap — deterministic, the LLM lane's risk/incompleteness, an
    // incomplete required candidate-CI lane, OR any workflow-prerequisite state —
    // cannot soften a confirmed deterministic stop. A confirmed Scruffy stop
    // dominates every prerequisite state and remains non-overridable. Stop wins.
    return { outcome: "stop", reasons: dedupe(stops.map((d) => d.reason)), dispositions, summary, coverage };
  }

  // A non-approvable prerequisite (pending / absent / unverifiable / ineligible
  // configuration) is evidence that is NOT a result: it can neither ship nor enter a
  // human sign-off Environment. It fails closed to `indeterminate` — the one
  // non-approvable, non-stop outcome — ahead of every escalation route, because we
  // cannot even establish the prerequisite yet. It never softens the stop above.
  if (prerequisite?.kind === "not-approvable") {
    return {
      outcome: "indeterminate",
      reasons: dedupe(prerequisite.reasons),
      dispositions,
      summary,
      coverage,
    };
  }

  const modelRisk = (llm?.retainedRiskCount ?? 0) > 0;
  const llmIncomplete = llm !== undefined && !llm.complete;
  const ciIncomplete = ci !== undefined && ci.required && !ci.complete;
  const prereqSignoff = prerequisite?.kind === "sign-off";
  const escalations = dispositions.filter((d) => d.effect === "escalates");
  if (
    escalations.length > 0 ||
    !coverage.complete ||
    modelRisk ||
    llmIncomplete ||
    ciIncomplete ||
    prereqSignoff
  ) {
    // An incomplete analysis, a retained model risk, an incomplete required evidence
    // lane, OR a workflow-prerequisite sign-off (a terminal workflow failure, a first
    // baseline, or an authority change) escalates on its own: shipping code we never
    // fully reviewed — or whose required workflows failed / whose release authority
    // changed — is a human's call, not ours.
    const reasons = dedupe(escalations.map((d) => d.reason));
    if (!coverage.complete) reasons.push("analysis_incomplete");
    if (modelRisk) reasons.push("model_risk_present");
    if (llmIncomplete) reasons.push("llm_lane_incomplete");
    if (ciIncomplete) reasons.push("ci_lane_incomplete");
    if (prereqSignoff) reasons.push(...prerequisite.reasons);
    return { outcome: "sign-off-required", reasons: dedupe(reasons), dispositions, summary, coverage };
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
