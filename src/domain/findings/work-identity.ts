import { createHash } from "node:crypto";
import { z } from "zod";
import { SubjectRevision, type Finding } from "../evidence/types.js";
import type { CoverageGap } from "../evidence/coverage.js";
import { findingKey } from "./identity.js";

/**
 * Immutable identities for the nightly report/work graph.
 *
 * WHY THIS EXISTS. Everything downstream of a nightly review is idempotent only
 * if it can name what it is about. Two failure modes motivate the shape:
 *
 *  1. A LOSSY key lets two different defects collide, so one real piece of work
 *     silently disappears (the same scar `fixBranch` already carries: a slugged
 *     path aliases `src/a.b.ts` with `src/a-b.ts`).
 *  2. A key that is NOT candidate-bound lets today's finding match yesterday's
 *     closed PR, so a live defect looks like it was already handled.
 *
 * The fix is three nested identities, each a superset of the last:
 *
 *   report      = (repository, branch, baseSha, headSha, policyVersion, schemaVersion)
 *   occurrence  = report + normalized finding key
 *   proposal    = occurrence + fixer/model/prompt/proposal-schema versions
 *
 * Every component is JSON-encoded as a positional array before hashing, so no
 * component value can impersonate a delimiter and alias two distinct identities.
 * Pure: no clock, no randomness — an exact replay of the same inputs yields the
 * same ids, which is what makes "commit the graph twice, get one graph" work.
 */

/**
 * Version of the report/work-graph SHAPE. Bumping it deliberately re-identifies
 * every report (and therefore every occurrence and proposal), because a report
 * with different semantics is not the same report.
 */
export const NIGHTLY_REPORT_SCHEMA_VERSION = "nightly-report-1";

/** Version of the fix-proposal shape. Part of the proposal identity. */
export const FIX_PROPOSAL_SCHEMA_VERSION = "fix-proposal-1";

/**
 * Version of the built-in deterministic fixer suite. Deterministic fixers are
 * pure service-owned code with no self-reported version, so the suite carries one
 * on their behalf: bump it whenever a fixer's output changes, so a new proposal is
 * a NEW identity rather than a silent redefinition of an existing one.
 */
export const DETERMINISTIC_FIXER_SUITE_VERSION = "deterministic-fixers-1";

const Sha40 = z.string().regex(/^[0-9a-f]{40}$/, "must be a full 40-char sha");

/**
 * The immutable identity of one nightly review. `baseSha` is null for a branch's
 * first-ever review; it is part of the identity because a report over
 * `(null, head]` reviewed strictly more than one over `(X, head]`.
 */
export const NightlyReportIdentity = z.object({
  repository: SubjectRevision.shape.repository,
  branch: z.string().min(1),
  baseSha: Sha40.nullable(),
  headSha: Sha40,
  policyVersion: z.string().min(1),
  schemaVersion: z.string().min(1),
});
export type NightlyReportIdentity = z.infer<typeof NightlyReportIdentity>;

/** One deduplicated finding as seen by ONE report. */
export const FindingOccurrenceIdentity = z.object({
  report: NightlyReportIdentity,
  /** Normalized finding key (see `domain/findings/identity.ts`). */
  findingKey: z.string().min(1),
});
export type FindingOccurrenceIdentity = z.infer<typeof FindingOccurrenceIdentity>;

/** Which fixer, model, and prompt produced a proposal. Part of its identity. */
export const RemediationProvenance = z.object({
  /** `deterministic` = service-owned pure fixer; `model` = LLM remediation. */
  fixerKind: z.enum(["deterministic", "model"]),
  fixerId: z.string().min(1),
  fixerVersion: z.string().min(1),
  modelId: z.string().nullable(),
  promptVersion: z.string().nullable(),
  proposalSchemaVersion: z.string().min(1),
});
export type RemediationProvenance = z.infer<typeof RemediationProvenance>;

export const FixProposalIdentity = z.object({
  occurrence: FindingOccurrenceIdentity,
  provenance: RemediationProvenance,
});
export type FixProposalIdentity = z.infer<typeof FixProposalIdentity>;

/** 128 bits of a sha256 over the JSON-encoded components. */
function digest(components: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(components)).digest("hex").slice(0, 32);
}

/**
 * Stable id for a nightly report. Prefixed so an id is self-describing in logs
 * and can never be confused with an occurrence or proposal id.
 */
export function nightlyReportId(identity: NightlyReportIdentity): string {
  return `nrp_${digest([
    identity.schemaVersion,
    identity.repository,
    identity.branch,
    identity.baseSha,
    identity.headSha,
    identity.policyVersion,
  ])}`;
}

/** Stable id for one finding occurrence within one report. */
export function findingOccurrenceId(identity: FindingOccurrenceIdentity): string {
  return `nfo_${digest([nightlyReportId(identity.report), identity.findingKey])}`;
}

/** Stable id for one fix proposal for one finding occurrence. */
export function fixProposalId(identity: FixProposalIdentity): string {
  return `nfp_${digest([
    findingOccurrenceId(identity.occurrence),
    identity.provenance.proposalSchemaVersion,
    identity.provenance.fixerKind,
    identity.provenance.fixerId,
    identity.provenance.fixerVersion,
    identity.provenance.modelId,
    identity.provenance.promptVersion,
  ])}`;
}

/** The occurrence identity of `finding` as seen by `report`. */
export function occurrenceOf(report: NightlyReportIdentity, finding: Finding): FindingOccurrenceIdentity {
  return { report, findingKey: findingKey(finding) };
}

/** Provenance for a built-in deterministic fixer keyed by defect class. */
export function deterministicFixerProvenance(defectClass: string): RemediationProvenance {
  return {
    fixerKind: "deterministic",
    fixerId: `deterministic:${defectClass}`,
    fixerVersion: DETERMINISTIC_FIXER_SUITE_VERSION,
    modelId: null,
    promptVersion: null,
    proposalSchemaVersion: FIX_PROPOSAL_SCHEMA_VERSION,
  };
}

/**
 * Work-item ids. A work item is the durable intent to publish something for a
 * human (brief 02 turns these into GitHub issues), so its id must be derivable
 * from the report/occurrence identity alone — that is what makes re-committing
 * the same report, or resuming after a crashed publication, land on the SAME work
 * item instead of a duplicate issue.
 */
export function runWorkItemId(report: NightlyReportIdentity): string {
  return `nwi_run_${digest([nightlyReportId(report)])}`;
}

export function findingWorkItemId(occurrence: FindingOccurrenceIdentity): string {
  return `nwi_fnd_${digest([findingOccurrenceId(occurrence)])}`;
}

/**
 * Work-item id for one coverage gap. Keyed on (analyzer, code) and NOT on the
 * free-form detail: the same analyzer failing the same way twice in one report is
 * one piece of work, and a detail string that embeds a timestamp or an error
 * address must not mint a new work item every attempt.
 */
export function coverageWorkItemId(report: NightlyReportIdentity, gap: Pick<CoverageGap, "analyzerId" | "code">): string {
  return `nwi_cov_${digest([nightlyReportId(report), gap.analyzerId, gap.code])}`;
}
