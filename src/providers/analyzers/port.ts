import type { Finding, SubjectRevision } from "../../domain/evidence/types.js";
import type { CoverageGap } from "../../domain/evidence/coverage.js";
import type { ChangedFile } from "../scm/port.js";

/**
 * Analyzer port. An analyzer inspects changed files and emits candidate findings
 * carrying full provenance and evidence. Analyzers do NOT decide — they produce
 * evidence the pure poison kernel later evaluates against policy.
 *
 * Findings are emitted with validation `pending`; a separate validation step
 * sets the terminal validation outcome. Language-specific and model-backed
 * analyzers implement this same port.
 *
 * An analyzer returns an `AnalyzerResult`, not a bare `Finding[]`, so that
 * "I found nothing" and "I could not look" are DISTINGUISHABLE — see
 * domain/evidence/coverage.ts. Returning `[]` with no gap is a positive claim
 * that the change was reviewed and is clean; any analyzer that swallows an error
 * must report a gap instead.
 */
export interface AnalyzerResult {
  findings: Finding[];
  /** Empty means the analyzer reviewed the whole change successfully. */
  gaps: CoverageGap[];
}

export interface Analyzer {
  readonly id: string;
  analyze(subject: SubjectRevision, files: ChangedFile[]): Promise<AnalyzerResult>;
}

/** Result for an analyzer that reviewed everything it was given. */
export function reviewed(findings: Finding[]): AnalyzerResult {
  return { findings, gaps: [] };
}

/** Result for an analyzer that was partially or wholly blind. */
export function partiallyReviewed(findings: Finding[], gaps: CoverageGap[]): AnalyzerResult {
  return { findings, gaps };
}
