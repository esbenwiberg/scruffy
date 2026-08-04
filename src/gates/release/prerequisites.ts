import type { ScmReader } from "../../providers/scm/port.js";
import type { WorkflowRunReader } from "../../providers/scm/port.js";
import {
  evaluateReleaseAuthority,
  type ReleaseAuthorityRange,
} from "./release-authority.js";
import type { ReleaseAuthorityAssessment } from "../../domain/release/authority-change.js";
import {
  aggregateRequiredWorkflows,
  classifyRequiredWorkflow,
  type ClassifiedRequiredWorkflow,
  type RequiredWorkflowAggregate,
} from "../../domain/release/required-workflow-evidence.js";
import {
  buildPrerequisiteSnapshot,
  type ReleasePrerequisiteSnapshot,
} from "../../domain/release/prerequisite-snapshot.js";
import {
  derivePrerequisiteState,
  type ReleasePrerequisiteState,
} from "./decision.js";

/**
 * The single, shared IO orchestration for the repository-owned release-prerequisite
 * lane. It resolves — for the EXACT candidate — the three provider-neutral facts the
 * design makes authoritative and folds them into one identity-bearing snapshot plus
 * its service-owned decision state:
 *
 *   1. the release-authority baseline/change assessment (candidate + previous config
 *      identity, first-adoption, semantic config change, and the exact `.github`
 *      authority paths that changed) — via `evaluateReleaseAuthority`;
 *   2. the repository's default branch, read from the provider (never a guessed
 *      `main`) — via `WorkflowRunReader.resolveDefaultBranch`;
 *   3. every CONFIGURED required workflow's exact current run/attempt evidence,
 *      classified into a service-owned state and aggregated conservatively — via
 *      `WorkflowRunReader.resolveRequiredWorkflowRun`.
 *
 * It is deliberately used by BOTH the report-time resolution (so the produced report
 * is prerequisite-aware and the run identity carries the evidence digest) AND the
 * authorization-time revalidation (so the terminal boundary re-reads and compares the
 * fresh snapshot against the report's exact evidence). The same code path guarantees
 * report-time and authorization-time snapshots are computed identically.
 *
 * FAIL-CLOSED discipline:
 *  - an ineligible candidate configuration (missing/malformed/empty/self-reference)
 *    leaves `authority.candidate` null; there are no configured workflows to read, so
 *    the aggregate is an empty fail-closed set and the derived state is not-approvable
 *    (the authority ineligibility dominates);
 *  - a default-branch read fault means NO workflow evidence can be scoped to the
 *    candidate's release branch, so every configured workflow is treated as
 *    `unverifiable` (a provider fault is never an empty-and-green lane).
 */
export interface ResolvedReleasePrerequisites {
  snapshot: ReleasePrerequisiteSnapshot;
  state: ReleasePrerequisiteState;
  assessment: ReleaseAuthorityAssessment;
  aggregate: RequiredWorkflowAggregate;
}

export interface ReleasePrerequisiteDeps {
  scm: ScmReader;
  workflowRuns: WorkflowRunReader;
}

export async function resolveReleasePrerequisites(
  range: ReleaseAuthorityRange,
  deps: ReleasePrerequisiteDeps,
): Promise<ResolvedReleasePrerequisites> {
  const assessment = await evaluateReleaseAuthority(range, deps.scm);

  const aggregate = await resolveWorkflowAggregate(range, assessment, deps.workflowRuns);
  const snapshot = buildPrerequisiteSnapshot(assessment, aggregate);
  const state = derivePrerequisiteState(assessment, aggregate);
  return { snapshot, state, assessment, aggregate };
}

async function resolveWorkflowAggregate(
  range: ReleaseAuthorityRange,
  assessment: ReleaseAuthorityAssessment,
  workflowRuns: WorkflowRunReader,
): Promise<RequiredWorkflowAggregate> {
  // No readable/valid candidate configuration → no configured workflows to look at.
  // The empty aggregate is a defensive fail-closed; the authority ineligibility is
  // what actually drives the derived not-approvable state.
  if (assessment.candidate === null) {
    return aggregateRequiredWorkflows([]);
  }
  const paths = assessment.candidate.config.requiredWorkflows;

  // The default branch is a provider fact required to scope every workflow's runs to
  // the candidate's release evidence. A fault here cannot prove any workflow green, so
  // every configured workflow is unverifiable and the aggregate fails closed.
  let defaultBranch: string;
  try {
    defaultBranch = await workflowRuns.resolveDefaultBranch(range.repository);
  } catch (error) {
    const detail = `default branch could not be resolved: ${message(error)}`;
    return aggregateRequiredWorkflows(
      paths.map((workflowPath) => ({ workflowPath, state: "unverifiable", detail })),
    );
  }

  const classified: ClassifiedRequiredWorkflow[] = [];
  for (const workflowPath of paths) {
    let resolution;
    try {
      resolution = await workflowRuns.resolveRequiredWorkflowRun({
        repository: range.repository,
        workflowPath,
        candidateSha: range.candidateSha,
        defaultBranch,
      });
    } catch (error) {
      // The adapter is contracted to return `unverifiable` for provider faults, but an
      // UNEXPECTED throw must still never crash the lane or read as green — record it
      // as unverifiable over this exact workflow.
      classified.push({
        workflowPath,
        state: "unverifiable",
        detail: `workflow evidence read threw: ${message(error)}`,
      });
      continue;
    }
    classified.push(classifyRequiredWorkflow(resolution));
  }
  return aggregateRequiredWorkflows(classified);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
