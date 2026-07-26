import type { Finding } from "../../domain/evidence/types.js";
import type { AnalysisCoverage } from "../../domain/evidence/coverage.js";
import type { PoisonPolicy } from "../../domain/policy/types.js";

/**
 * The poison decision kernel: a pure function over immutable, already-validated
 * inputs. No IO, no clock, no randomness. Callers parse untrusted input through
 * the zod schemas first, then hand typed values here.
 *
 * Contract (ADR 0003 / heritage assessment):
 *   evaluatePoison(findings, policy) -> block | allow | indeterminate
 *
 * Safety invariants encoded here:
 *  1. Only defect classes the policy lists as blockable can block.
 *  2. Raw model self-confidence is not a safety boundary: a block requires at
 *     least one deterministic supporting item.
 *  3. Insufficient evidence or unavailable validation on a serious candidate
 *     yields ABSTAIN (indeterminate), never a silent allow. Abstention escalates
 *     to a deeper gate.
 *  4. Infrastructure failure (validation `failed`) is treated as "could not
 *     decide", never as "validated".
 *  5. ALLOW REQUIRES COMPLETE COVERAGE. An analyzer that could not run returns no
 *     findings, which is shape-identical to a clean review. Without coverage the
 *     kernel would read "we were blind" as "nothing here" and allow — the exact
 *     silent under-report invariant 3 exists to prevent, arriving through the
 *     back door. Coverage never softens a block: being blind in one place is no
 *     reason to stop trusting what we did see.
 */

/** Stable reason codes. Never free-form; these are part of the audit contract. */
export type PoisonReasonCode =
  | "no_blockable_findings"
  | "all_candidates_refuted"
  | "blockable_class_confirmed"
  | "insufficient_evidence"
  | "no_deterministic_corroboration"
  | "validation_unavailable"
  | "analysis_incomplete";

export interface FindingDisposition {
  ruleId: string;
  defectClass: string;
  /** Whether this finding contributed to the overall outcome, and how. */
  effect: "blocks" | "abstains" | "dismissed" | "not_blockable";
  reason: PoisonReasonCode;
}

interface PoisonDecisionBase {
  reasons: PoisonReasonCode[];
  dispositions: FindingDisposition[];
  /** What the analyzers actually managed to review. Carried for the audit trail. */
  coverage: AnalysisCoverage;
}

export type PoisonDecision =
  | ({ outcome: "block" } & PoisonDecisionBase)
  | ({ outcome: "allow" } & PoisonDecisionBase)
  | ({ outcome: "indeterminate" } & PoisonDecisionBase);

function hasDeterministicSupport(finding: Finding): boolean {
  return finding.supporting.some((e) => e.trust === "deterministic");
}

/** Classify a single finding against policy. */
function disposition(finding: Finding, policy: PoisonPolicy): FindingDisposition {
  const base = { ruleId: finding.ruleId, defectClass: finding.defectClass };

  if (!policy.blockableDefectClasses.includes(finding.defectClass)) {
    return { ...base, effect: "not_blockable", reason: "no_blockable_findings" };
  }

  if (finding.validation === "refuted") {
    return { ...base, effect: "dismissed", reason: "all_candidates_refuted" };
  }

  // A blockable-class candidate we cannot clear must cause abstention, not allow.
  if (!finding.completeness.requiredEvidencePresent) {
    return { ...base, effect: "abstains", reason: "insufficient_evidence" };
  }

  if (!hasDeterministicSupport(finding)) {
    return { ...base, effect: "abstains", reason: "no_deterministic_corroboration" };
  }

  if (policy.requireValidation && finding.validation !== "validated") {
    // pending | indeterminate | failed | not_requested — none is confirmation.
    return { ...base, effect: "abstains", reason: "validation_unavailable" };
  }

  return { ...base, effect: "blocks", reason: "blockable_class_confirmed" };
}

/**
 * `coverage` is REQUIRED, not defaulted to complete. A forgotten argument would
 * default to the permissive reading of a blind run, and the compiler is the only
 * thing that reliably catches that. Callers with genuinely complete coverage pass
 * COMPLETE_COVERAGE and say so explicitly.
 */
export function evaluatePoison(
  findings: readonly Finding[],
  policy: PoisonPolicy,
  coverage: AnalysisCoverage,
): PoisonDecision {
  const dispositions = findings.map((f) => disposition(f, policy));

  const blocking = dispositions.filter((d) => d.effect === "blocks");
  if (blocking.length > 0) {
    // A coverage gap does not weaken a confirmed block; it is checked below,
    // where it can only make the outcome MORE conservative.
    return {
      outcome: "block",
      reasons: dedupe(blocking.map((d) => d.reason)),
      dispositions,
      coverage,
    };
  }

  const abstaining = dispositions.filter((d) => d.effect === "abstains");
  if (abstaining.length > 0) {
    return {
      outcome: "indeterminate",
      reasons: dedupe(abstaining.map((d) => d.reason)),
      dispositions,
      coverage,
    };
  }

  // Nothing blocked and nothing abstained — but "no findings" only means "clean"
  // if we actually looked. Blind is not clean: abstain and let a deeper gate see it.
  if (!coverage.complete) {
    return {
      outcome: "indeterminate",
      reasons: ["analysis_incomplete"],
      dispositions,
      coverage,
    };
  }

  // Allow: no blocker, nothing left to abstain on, full coverage. Reasons reflect
  // why each remaining candidate was cleared (dismissed vs never blockable).
  const allowReasons = dedupe(dispositions.map((d) => d.reason));
  return {
    outcome: "allow",
    reasons: allowReasons.length > 0 ? allowReasons : ["no_blockable_findings"],
    dispositions,
    coverage,
  };
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}
