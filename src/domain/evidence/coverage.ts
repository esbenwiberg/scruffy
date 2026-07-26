/**
 * Analysis coverage — how much of the change we actually managed to look at.
 *
 * WHY THIS EXISTS. An analyzer that returns no findings is making one of two
 * completely different claims:
 *   a) "I reviewed this and it is clean"
 *   b) "I could not review this" (backend down, output unusable, input truncated)
 * Before coverage, both came back as `[]` and the gates could not tell them
 * apart, so (b) rendered as a clean bill of health. That is precisely the
 * silent under-report the product exists to prevent — the same failure mode
 * `claude-cli.ts` documents for truncated completions, but at the analyzer level
 * rather than the backend level.
 *
 * Coverage is the channel for (b). It is CARRIED SEPARATELY FROM FINDINGS on
 * purpose: `completeness` on a Finding can only describe a finding that exists,
 * and the dangerous case is having none.
 *
 * The rule the kernels apply: a gap can never clear a confirmed defect, and a
 * confirmed defect can never be softened by a gap — but the PERMISSIVE outcome
 * (poison `allow`, release `ship`) requires COMPLETE coverage. Blind is not
 * clean.
 */

/** Stable gap codes. Part of the audit contract; never free-form. */
export type CoverageGapCode =
  /** Could not reach the analyzer's backend at all (network, spawn, timeout). */
  | "provider_unavailable"
  /** Reached it, but the response could not be parsed into findings. */
  | "unparseable_output"
  /** We deliberately did not show the analyzer the whole change. */
  | "input_truncated"
  /** The analyzer produced more findings than we were willing to carry. */
  | "output_capped";

export interface CoverageGap {
  /** Which analyzer was blind. */
  analyzerId: string;
  code: CoverageGapCode;
  /** Human-readable specifics for the audit trail. Never parsed. */
  detail: string;
}

export interface AnalysisCoverage {
  /** True only when every analyzer reviewed the whole change successfully. */
  complete: boolean;
  gaps: readonly CoverageGap[];
}

/** The only coverage value that permits a permissive outcome. */
export const COMPLETE_COVERAGE: AnalysisCoverage = Object.freeze({ complete: true, gaps: Object.freeze([]) });

/** Build coverage from the gaps collected across a run's analyzers. */
export function coverageFrom(gaps: readonly CoverageGap[]): AnalysisCoverage {
  return gaps.length === 0 ? COMPLETE_COVERAGE : { complete: false, gaps: [...gaps] };
}

/**
 * Sentinel analyzerId for a gap not attributable to any one analyzer — the run
 * failed before or across the analyzers (SCM read failed, lease lost, retries
 * exhausted). Nothing was reviewed at all.
 */
export const WHOLE_ANALYSIS = "analysis";

/** Coverage for a run whose analysis never completed. Reviewed nothing, claims nothing. */
export function analysisFailed(detail: string): AnalysisCoverage {
  return { complete: false, gaps: [{ analyzerId: WHOLE_ANALYSIS, code: "provider_unavailable", detail }] };
}

/** One-line audit rendering, e.g. `model-analyzer: provider_unavailable`. */
export function describeGaps(gaps: readonly CoverageGap[]): string {
  return gaps.map((g) => `${g.analyzerId}: ${g.code}`).join("; ");
}
