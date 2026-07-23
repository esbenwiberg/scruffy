import { z } from "zod";

/**
 * Evidence contracts. These are the wire/persistence/domain boundary types:
 * every finding that enters the decision kernel is parsed through these schemas
 * first. TypeScript types are inferred from the schemas so the runtime check and
 * the compile-time type can never drift (ADR 0003).
 *
 * Design stance from the heritage assessment:
 *  - "Completeness" is about whether required evidence is present, NOT a
 *    probability of correctness. A model asserting it saw full context does not
 *    make a finding correct.
 *  - Trust level records where a claim came from. Repository-supplied content is
 *    hostile input and can never, on its own, justify a block.
 */

/** Where a piece of evidence originated. Ordered from most to least trusted. */
export const TrustLevel = z.enum([
  "deterministic", // produced by a service-owned analyzer with reproducible output
  "model-asserted", // produced by a model; plausible but uncalibrated
  "repository-supplied", // came from the reviewed repo; untrusted / hostile input
]);
export type TrustLevel = z.infer<typeof TrustLevel>;

/**
 * Explicit lifecycle of adversarial validation. A poison block requires
 * `validated`. Crucially, `failed` and `indeterminate` are NOT `validated`:
 * infrastructure failure must never be recorded as a successful validation.
 */
export const ValidationOutcome = z.enum([
  "not_requested",
  "pending",
  "validated", // independently corroborated
  "refuted", // independent evidence contradicts the finding
  "indeterminate", // validation ran but could not decide
  "failed", // validation could not run (timeout, parser error, provider down)
]);
export type ValidationOutcome = z.infer<typeof ValidationOutcome>;

/** Immutable identification of the subject a finding was produced against. */
export const SubjectRevision = z.object({
  // Exactly two non-empty, slash-free segments — "owner/name". Enforced (not just
  // documented) because this value is interpolated into `gh api` URL paths, where
  // an extra segment or "../" would retarget a different endpoint.
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be owner/name"),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/, "must be a full 40-char sha"),
});
export type SubjectRevision = z.infer<typeof SubjectRevision>;

/** Versions of everything that produced a finding, for reproducibility. */
export const Provenance = z.object({
  analyzerId: z.string().min(1),
  analyzerVersion: z.string().min(1),
  modelId: z.string().nullable(),
  promptVersion: z.string().nullable(),
});
export type Provenance = z.infer<typeof Provenance>;

/** A concrete location in the reviewed source. */
export const CodeRegion = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  /** The exact quoted text the finding is about. */
  snippet: z.string(),
});
export type CodeRegion = z.infer<typeof CodeRegion>;

/**
 * A single supporting or contradicting observation. `trust` records provenance;
 * `deterministic` evidence is the only kind that can independently justify a
 * poison block.
 */
export const EvidenceItem = z.object({
  trust: TrustLevel,
  statement: z.string().min(1),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

/**
 * Whether a finding carries the evidence its defect class requires to be
 * eligible for blocking. Incomplete evidence => the finding cannot block;
 * the gate abstains rather than inventing confidence.
 */
export const EvidenceCompleteness = z.object({
  /** Required evidence fields for this defect class were all present. */
  requiredEvidencePresent: z.boolean(),
  /** Analysis context was truncated (files/symbols omitted). */
  contextTruncated: z.boolean(),
});
export type EvidenceCompleteness = z.infer<typeof EvidenceCompleteness>;

/**
 * A candidate defect. Identity is a stable (ruleId, defectClass) pair plus a
 * normalized location — deliberately not `file::category::agent`, which the
 * heritage assessment flagged as too fragile.
 */
export const Finding = z.object({
  ruleId: z.string().min(1),
  defectClass: z.string().min(1),
  subject: SubjectRevision,
  primaryRegion: CodeRegion,
  provenance: Provenance,
  supporting: z.array(EvidenceItem),
  contradicting: z.array(EvidenceItem),
  completeness: EvidenceCompleteness,
  validation: ValidationOutcome,
});
export type Finding = z.infer<typeof Finding>;
