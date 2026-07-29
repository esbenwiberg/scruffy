import { z } from "zod";
import { CaseProvenance, ChangedFileInput } from "./types.js";
import { ReleaseRisk } from "../domain/release/report.js";
import type { CandidateCiState } from "../providers/scm/port.js";

/**
 * Labeled corpus for the RELEASE gate. Where the nightly corpus scores per-finding
 * dispositions over a range, a release case scores the ONE aggregate outcome the
 * gate reaches over the (prev-release, candidate] range — the release analog of
 * the poison corpus, which scores one outcome per subject.
 *
 * Same hard rule as the rest of the corpus: synthetic or sanitized, invented
 * identifiers, provenance recorded. This repo is public; never commit real
 * repo-derived content.
 */

/**
 * Ground-truth outcome a perfect gate should reach for the range. Deliberately
 * excludes `indeterminate`: indeterminate is an OPERATIONAL abstention (the
 * analysis machinery failed), never a property of the change itself, so it can
 * never be the "truth" of a range.
 */
export const ReleaseTruthOutcome = z.enum(["ship", "sign-off-required", "stop"]);
export type ReleaseTruthOutcome = z.infer<typeof ReleaseTruthOutcome>;

/** All four outcomes the gate can actually produce (regression pin + scoring). */
export const ReleaseActualOutcome = z.enum(["ship", "sign-off-required", "stop", "indeterminate"]);
export type ReleaseActualOutcome = z.infer<typeof ReleaseActualOutcome>;

/** CI state vocabulary for campaign fake evidence — mirrors CandidateCiState. */
export const CampaignCiState = z.enum([
  "success",
  "failure",
  "pending",
  "cancelled",
  "timed-out",
  "neutral",
  "action-required",
  "error",
  "unknown",
]);
// Compile-time parity: the campaign CI vocabulary must equal the SCM port's, so a
// new normalized state can never silently go untested here.
type _CiParity = [CandidateCiState] extends [z.infer<typeof CampaignCiState>]
  ? [z.infer<typeof CampaignCiState>] extends [CandidateCiState]
    ? true
    : never
  : never;
const _ciParity: _CiParity = true;
void _ciParity;

/** Coverage-gap codes an LLM lane can report — mirrors CoverageGapCode. */
export const CampaignGapCode = z.enum(["provider_unavailable", "unparseable_output", "input_truncated", "output_capped"]);

/**
 * Explicit, honest fake evidence for the REQUIRED campaign lanes. Present only on
 * campaign pressure cases, which replay under a policy that requires all three
 * lanes. The clean case seeds every lane complete; each unsafe case alters EXACTLY
 * one condition. Tests must inject this rather than bypass a lane — a case with no
 * campaign block is a legacy deterministic case (offline policy, no LLM/CI lanes).
 */
export const ReleaseCampaignEvidence = z.object({
  /**
   * Fake range-level LLM assessment. `null` ⇒ NO analyst is wired for this run
   * (unsupported required evidence: the lane is required by policy but blind). A
   * non-null value scripts the analyst's risks/coverage directly.
   */
  llm: z
    .object({
      risks: z.array(ReleaseRisk),
      gaps: z.array(z.object({ code: CampaignGapCode, detail: z.string().min(1) })),
      reviewedLines: z.number().int().nonnegative(),
      totalLines: z.number().int().nonnegative(),
    })
    .nullable(),
  /** Fake normalized candidate-CI records for the exact candidate (context + state). */
  ci: z.array(z.object({ context: z.string().min(1), state: CampaignCiState })),
});
export type ReleaseCampaignEvidence = z.infer<typeof ReleaseCampaignEvidence>;

export const ReleaseCase = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  range: z.object({
    repository: z.string().min(1),
    baseSha: z.string().nullable(),
    headSha: z.string().min(1),
  }),
  files: z.array(ChangedFileInput),
  /** What a perfect gate should decide for this range. */
  truthOutcome: ReleaseTruthOutcome,
  /**
   * Optional regression pin: the outcome we currently expect the skeleton to
   * produce. Distinct from truth — a legitimate sign-off on a range that ideally
   * could auto-ship is a safe, correct behavior even if it is not the ideal.
   */
  expectedOutcome: ReleaseActualOutcome.optional(),
  /**
   * Explicit fake evidence for the required LLM + candidate-CI lanes. Present only
   * on campaign pressure cases (replayed under the all-lanes-required policy).
   */
  campaign: ReleaseCampaignEvidence.optional(),
  provenance: CaseProvenance,
});
export type ReleaseCase = z.infer<typeof ReleaseCase>;

export const ReleaseCorpus = z.array(ReleaseCase);
export type ReleaseCorpus = z.infer<typeof ReleaseCorpus>;
