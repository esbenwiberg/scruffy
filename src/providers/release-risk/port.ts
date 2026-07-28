import type { CoverageGapCode } from "../../domain/evidence/coverage.js";
import type { ReleaseRisk } from "../../domain/release/report.js";
import type { ChangedFile, RevisionRange } from "../scm/port.js";

/**
 * Range-level release-risk analyst port.
 *
 * This is DELIBERATELY NOT the line-level `Analyzer`. The `Analyzer` emits
 * semantic defect findings (sql-injection, missing-authorization, …) anchored to
 * a single added line, and feeds the poison/nightly/release finding pipeline. The
 * release-risk analyst answers a different question: over the WHOLE immutable
 * (prev-release, candidate] range, what release-wide behavioral risks and
 * cross-change interactions could this candidate introduce? Its output is a
 * change summary plus structured, cited, model-asserted RISKS — not defect
 * findings — and it carries its own coverage channel.
 *
 * Trust posture (identical stance to the model analyzer, and load-bearing):
 *  - every emitted risk is MODEL-ASSERTED only. A risk never manufactures `stop`;
 *    a retained risk escalates to human sign-off and nothing stronger. The model
 *    does not get to choose trust, policy, outcome, applicability, or a waiver.
 *  - model OUTPUT is hostile: it is parsed through a schema, every risk category
 *    must be in the fixed vocabulary, and every citation must ANCHOR to a real
 *    changed line in the supplied range. Fabricated paths/lines are dropped and
 *    can never enter the report.
 *  - model INPUT is hostile too: the diff is author-controlled, so it is fenced
 *    and sanitized (see providers/prompts/untrusted.ts).
 *  - blindness is reported as blindness. Provider failure, unparseable output,
 *    input truncation not covered by complete chunk accounting, or an output cap
 *    each produce an EXPLICIT coverage gap — never a silent "reviewed, clean".
 *    Dropping suspicious output must never turn into a complete, empty risk list.
 *
 * A deterministic fake (the fake model provider behind the model implementation)
 * and the model-backed implementation are both injectable, so ordinary tests
 * never make a live model call.
 */

/** One explicit coverage gap in the release-risk lane. Mirrors the analyzer gap codes. */
export interface ReleaseRiskGap {
  code: CoverageGapCode;
  /** Human-readable specifics for the audit trail. Never parsed. */
  detail: string;
}

/**
 * The result of one range-level release-risk assessment.
 *
 * `gaps` is the coverage channel: an EMPTY `gaps` with an EMPTY `risks` is the
 * only "complete and clean" answer, and it is valid only when the analyst saw its
 * entire bounded input. Any gap means the lane is incomplete — carried separately
 * from `risks` for exactly the reason coverage exists (see domain/evidence/coverage.ts):
 * "found no risks" and "could not look" must never collapse to the same value.
 */
export interface ReleaseRiskAssessment {
  /** A concise, model-authored description of what the range changes. May be "". */
  changeSummary: string;
  /** Retained, citation-anchored, model-asserted release risks. May be empty. */
  risks: ReleaseRisk[];
  /** Explicit coverage gaps. Empty ⇔ the analyst reviewed the whole bounded range. */
  gaps: ReleaseRiskGap[];
  /** Added lines actually shown to the model, and the total added across the range. */
  reviewedLines: number;
  totalLines: number;
  provenance: {
    /** The model that produced the assessment; null when the provider was never reached. */
    modelId: string | null;
    /** The versioned prompt identity the assessment was produced against. */
    promptVersion: string;
  };
}

/**
 * The narrow port. `id` is stable provenance. `assess` never throws for a
 * provider/parse failure — it returns an assessment carrying an explicit gap.
 */
export interface ReleaseRiskAnalyst {
  readonly id: string;
  readonly version: string;
  assess(range: RevisionRange, files: ChangedFile[]): Promise<ReleaseRiskAssessment>;
}
