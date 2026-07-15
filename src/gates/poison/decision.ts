import type { Finding } from "../../domain/evidence/types.js";
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
 */

/** Stable reason codes. Never free-form; these are part of the audit contract. */
export type PoisonReasonCode =
  | "no_blockable_findings"
  | "all_candidates_refuted"
  | "blockable_class_confirmed"
  | "insufficient_evidence"
  | "no_deterministic_corroboration"
  | "validation_unavailable";

export interface FindingDisposition {
  ruleId: string;
  defectClass: string;
  /** Whether this finding contributed to the overall outcome, and how. */
  effect: "blocks" | "abstains" | "dismissed" | "not_blockable";
  reason: PoisonReasonCode;
}

export type PoisonDecision =
  | { outcome: "block"; reasons: PoisonReasonCode[]; dispositions: FindingDisposition[] }
  | { outcome: "allow"; reasons: PoisonReasonCode[]; dispositions: FindingDisposition[] }
  | { outcome: "indeterminate"; reasons: PoisonReasonCode[]; dispositions: FindingDisposition[] };

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

export function evaluatePoison(findings: readonly Finding[], policy: PoisonPolicy): PoisonDecision {
  const dispositions = findings.map((f) => disposition(f, policy));

  const blocking = dispositions.filter((d) => d.effect === "blocks");
  if (blocking.length > 0) {
    return {
      outcome: "block",
      reasons: dedupe(blocking.map((d) => d.reason)),
      dispositions,
    };
  }

  const abstaining = dispositions.filter((d) => d.effect === "abstains");
  if (abstaining.length > 0) {
    return {
      outcome: "indeterminate",
      reasons: dedupe(abstaining.map((d) => d.reason)),
      dispositions,
    };
  }

  // Allow: no blocker, nothing left to abstain on. Reasons reflect why each
  // remaining candidate was cleared (dismissed vs never blockable).
  const allowReasons = dedupe(dispositions.map((d) => d.reason));
  return {
    outcome: "allow",
    reasons: allowReasons.length > 0 ? allowReasons : ["no_blockable_findings"],
    dispositions,
  };
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}
