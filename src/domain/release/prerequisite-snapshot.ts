import { createHash } from "node:crypto";
import { z } from "zod";
import type { ReleaseAuthorityAssessment } from "./authority-change.js";
import type { RequiredWorkflowAggregate } from "./required-workflow-evidence.js";

/**
 * The typed, identity-bearing prerequisite snapshot carried by a v3 release report.
 *
 * It packages the three provider-neutral prerequisite facts the design makes
 * authoritative for an exact candidate:
 *  - the canonical repository release-configuration identity (candidate + previous
 *    baseline) and its content digest;
 *  - the release-authority baseline/change assessment (first adoption, semantic
 *    configuration change, and the exact `.github` authority paths that changed);
 *  - every configured required workflow's EXACT current run/attempt evidence, its
 *    service-owned classified state, and the aggregate outcome over all of them.
 *
 * Plus a canonical `evidenceDigest` computed over all of the above. That digest is
 * what release-run identity binds to (see persistence/runs.ts): a changed current
 * attempt, status, conclusion, workflow identity, configuration, or authority path
 * yields a different digest and therefore a SUCCESSOR run/report for the same
 * deployment envelope, while an exact-unchanged retry reuses the same one.
 *
 * This module owns the SCHEMA and the pure mapping from the domain assessment +
 * aggregate; it does no IO. Slice 5 (hosted) resolves the assessment/aggregate live
 * and feeds them here; this brief provides the schema, digest, and builder.
 */

/** Canonical repository release-configuration identity for one revision. */
export const ReleaseConfigIdentitySnapshot = z.object({
  /** Canonical, sorted, unique `.github/workflows/*.yml|.yaml` paths. */
  requiredWorkflows: z.array(z.string().min(1)),
  /** Order-independent content digest of the parsed configuration. */
  digest: z.string().min(1),
});
export type ReleaseConfigIdentitySnapshot = z.infer<typeof ReleaseConfigIdentitySnapshot>;

/** One required workflow's exact current-attempt provider evidence (never a display name). */
export const RequiredWorkflowEvidenceSnapshot = z.object({
  workflowId: z.number().int(),
  workflowPath: z.string().min(1),
  runId: z.number().int(),
  runAttempt: z.number().int().positive(),
  event: z.string().min(1),
  branch: z.string().min(1),
  candidateSha: z.string().min(1),
  status: z.string().min(1),
  conclusion: z.string().nullable(),
  url: z.string().min(1),
});
export type RequiredWorkflowEvidenceSnapshot = z.infer<typeof RequiredWorkflowEvidenceSnapshot>;

/** One configured workflow resolved to its service-owned state and (when present) evidence. */
export const ClassifiedRequiredWorkflowSnapshot = z.object({
  workflowPath: z.string().min(1),
  state: z.enum(["passed", "terminal-failed", "pending", "absent", "unverifiable"]),
  evidence: RequiredWorkflowEvidenceSnapshot.optional(),
  detail: z.string().optional(),
});
export type ClassifiedRequiredWorkflowSnapshot = z.infer<typeof ClassifiedRequiredWorkflowSnapshot>;

/** Release-authority reason codes (owned by the authority-change kernel; mirrored here). */
export const ReleaseAuthorityReasonCodeSchema = z.enum([
  "authority_unchanged",
  "release_authority_baseline_required",
  "release_authority_changed",
  "release_config_missing",
  "release_config_invalid",
]);

/** Required-workflow aggregate reason codes (owned by the evidence kernel; mirrored here). */
export const RequiredWorkflowReasonCodeSchema = z.enum([
  "required_workflows_satisfied",
  "required_workflow_failed",
  "required_workflow_pending",
  "required_workflow_absent",
  "required_workflow_unverifiable",
]);

export const ReleasePrerequisiteSnapshot = z.object({
  /** Candidate configuration identity, or null when the candidate config is ineligible. */
  candidateConfig: ReleaseConfigIdentitySnapshot.nullable(),
  /** Previous baseline configuration identity, or null on first adoption. */
  previousConfig: ReleaseConfigIdentitySnapshot.nullable(),
  authority: z.object({
    outcome: z.enum(["clean", "sign-off-required", "ineligible"]),
    reasonCode: ReleaseAuthorityReasonCodeSchema,
    firstAdoption: z.boolean(),
    configChanged: z.boolean(),
    /** Exact `.github` authority paths that changed across the immutable range. */
    changedAuthorityPaths: z.array(z.string()),
    addedRequiredWorkflows: z.array(z.string()),
    removedRequiredWorkflows: z.array(z.string()),
  }),
  workflows: z.array(ClassifiedRequiredWorkflowSnapshot),
  aggregate: z.object({
    outcome: z.enum(["satisfied", "exception-eligible", "not-ready", "fail-closed"]),
    reasonCode: RequiredWorkflowReasonCodeSchema,
  }),
  /** Canonical digest over everything above; identity-bearing for the release run. */
  evidenceDigest: z.string().min(1),
});
export type ReleasePrerequisiteSnapshot = z.infer<typeof ReleasePrerequisiteSnapshot>;

/** The prerequisite snapshot without its own derived digest (the digest's preimage). */
export type ReleasePrerequisiteSnapshotContent = Omit<ReleasePrerequisiteSnapshot, "evidenceDigest">;

/**
 * Recursively sort object keys so serialization is independent of insertion order.
 * Arrays keep their order (meaningful — e.g. classified-workflow order). Kept local
 * to avoid a circular import with report.ts, which imports this module's schema.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * Canonical prerequisite-evidence digest over configuration authority and the exact
 * workflow run attempts. Independent of object key insertion order, so an unchanged
 * snapshot always digests to the same value (exact retry dedupes) and any mutation of
 * configuration, authority paths, workflow identity, run, attempt, status, or
 * conclusion changes it (a successor run/report is produced).
 */
export function computePrerequisiteEvidenceDigest(
  content: ReleasePrerequisiteSnapshotContent,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalize(content)))
    .digest("hex");
  return `pe_${digest}`;
}

/**
 * Build the identity-bearing prerequisite snapshot from the pure release-authority
 * assessment and the required-workflow aggregate. Pure over its inputs; it never
 * re-resolves provider facts. The evidence digest is derived from the resulting
 * content so it always matches what the report and run identity carry.
 */
export function buildPrerequisiteSnapshot(
  authority: ReleaseAuthorityAssessment,
  aggregate: RequiredWorkflowAggregate,
): ReleasePrerequisiteSnapshot {
  const content: ReleasePrerequisiteSnapshotContent = {
    candidateConfig: authority.candidate
      ? {
          requiredWorkflows: [...authority.candidate.config.requiredWorkflows],
          digest: authority.candidate.digest,
        }
      : null,
    previousConfig: authority.previous
      ? {
          requiredWorkflows: [...authority.previous.config.requiredWorkflows],
          digest: authority.previous.digest,
        }
      : null,
    authority: {
      outcome: authority.outcome,
      reasonCode: authority.reasonCode,
      firstAdoption: authority.firstAdoption,
      configChanged: authority.configChanged,
      changedAuthorityPaths: [...authority.changedAuthorityPaths],
      addedRequiredWorkflows: [...authority.addedRequiredWorkflows],
      removedRequiredWorkflows: [...authority.removedRequiredWorkflows],
    },
    workflows: aggregate.workflows.map((w) => ({
      workflowPath: w.workflowPath,
      state: w.state,
      ...(w.evidence !== undefined ? { evidence: { ...w.evidence } } : {}),
      ...(w.detail !== undefined ? { detail: w.detail } : {}),
    })),
    aggregate: { outcome: aggregate.outcome, reasonCode: aggregate.reasonCode },
  };
  return ReleasePrerequisiteSnapshot.parse({
    ...content,
    evidenceDigest: computePrerequisiteEvidenceDigest(content),
  });
}
