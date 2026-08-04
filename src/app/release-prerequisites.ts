import type { ScmReader, WorkflowRunReader } from "../providers/scm/port.js";
import type { SubjectRevision } from "../domain/evidence/types.js";
import {
  assessReleaseAuthority,
  selectChangedAuthorityPaths,
  type ReleaseConfigIdentity,
} from "../domain/release/authority-change.js";
import {
  RELEASE_CONFIG_PATH,
  parseRepositoryReleaseConfig,
  type RepositoryReleaseConfigParse,
} from "../domain/release/repository-config.js";
import {
  aggregateRequiredWorkflows,
  classifyRequiredWorkflow,
  type ClassifiedRequiredWorkflow,
  type RequiredWorkflowAggregate,
} from "../domain/release/required-workflow-evidence.js";
import {
  buildPrerequisiteSnapshot,
  type ReleasePrerequisiteSnapshot,
} from "../domain/release/prerequisite-snapshot.js";
import {
  derivePrerequisiteState,
  type ReleasePrerequisiteState,
} from "../gates/release/decision.js";

/**
 * Resolve the repository-owned release-prerequisite contribution for an EXACT candidate.
 *
 * This is the single IO boundary that turns provider facts into the identity-bearing
 * prerequisite snapshot and its service-owned decision state. It is called in two
 * places against the SAME resolution logic, so a report and its authorization can never
 * disagree about what the evidence was:
 *  - report creation (before the release run is ensured, so the evidence digest is part
 *    of run identity);
 *  - terminal authorization (immediately before persistence, to prove the evidence has
 *    not changed since the report).
 *
 * Every authoritative fact is read from the provider here — repository identity, default
 * branch, workflow identity, run/attempt, event, status, conclusion, and the candidate
 * SHA. NONE of it is accepted from the caller or from repository configuration; the
 * configuration only selects WHICH workflow paths to look at.
 *
 * Fail-closed discipline: a provider fault while resolving the default branch or a
 * workflow run is classified as `unverifiable` (never a silent green and never a
 * terminal failure), so an outage can neither ship nor be signed off.
 */
export interface PrerequisiteResolverDeps {
  scm: ScmReader;
  workflowRuns: WorkflowRunReader;
}

export interface PrerequisiteResolutionInput {
  repository: string;
  candidateSha: string;
  previousReleaseSha: string | null;
}

export interface ResolvedPrerequisite {
  snapshot: ReleasePrerequisiteSnapshot;
  state: ReleasePrerequisiteState;
}

export async function resolveReleasePrerequisites(
  deps: PrerequisiteResolverDeps,
  input: PrerequisiteResolutionInput,
): Promise<ResolvedPrerequisite> {
  const candidate = await readReleaseConfig(deps.scm, input.repository, input.candidateSha);
  const previous = await readPreviousConfigIdentity(
    deps.scm,
    input.repository,
    input.previousReleaseSha,
  );
  const { changedAuthorityPaths, rangeUnverifiable } = await readAuthorityChanges(deps.scm, input);

  const authority = assessReleaseAuthority({
    previousReleaseExists: input.previousReleaseSha !== null,
    candidate,
    previous,
    changedAuthorityPaths,
    authorityRangeUnverifiable: rangeUnverifiable,
  });

  const aggregate = await resolveWorkflowAggregate(deps, input, candidate);

  return {
    snapshot: buildPrerequisiteSnapshot(authority, aggregate),
    state: derivePrerequisiteState(authority, aggregate),
  };
}

/** Read + parse the candidate release configuration at the exact candidate SHA. */
async function readReleaseConfig(
  scm: ScmReader,
  repository: string,
  sha: string,
): Promise<RepositoryReleaseConfigParse> {
  const subject: SubjectRevision = { repository, commitSha: sha };
  const read = await scm.getFileContent(subject, RELEASE_CONFIG_PATH);
  if (read.complete) return parseRepositoryReleaseConfig(read.content);
  // A configuration that cannot be read completely — missing, binary, oversized, or a
  // provider fault — is NOT an approvable workflow failure. It is authorization-
  // ineligible (release_config_missing), so the whole lane fails closed.
  return {
    ok: false,
    code: "empty",
    detail: `${RELEASE_CONFIG_PATH} could not be read at ${sha}: ${read.reason}${
      read.detail !== undefined ? ` (${read.detail})` : ""
    }`,
  };
}

/**
 * Read the previous release's configuration identity, or null when there is no previous
 * release or its configuration is absent/unreadable/invalid. A null previous is handled
 * downstream as "no baseline yet" — a mandatory first-adoption sign-off — so an
 * unreadable previous config conservatively forces sign-off rather than shipping clean.
 */
async function readPreviousConfigIdentity(
  scm: ScmReader,
  repository: string,
  previousReleaseSha: string | null,
): Promise<ReleaseConfigIdentity | null> {
  if (previousReleaseSha === null) return null;
  const parse = await readReleaseConfig(scm, repository, previousReleaseSha);
  return parse.ok ? { config: parse.config, digest: parse.digest } : null;
}

/**
 * Which authority-relevant paths changed across `(previousReleaseSha, candidateSha]`.
 * A read fault cannot prove "unchanged", so it conservatively marks the range
 * unverifiable (which forces sign-off) rather than reporting an empty change set.
 */
async function readAuthorityChanges(
  scm: ScmReader,
  input: PrerequisiteResolutionInput,
): Promise<{ changedAuthorityPaths: string[]; rangeUnverifiable: boolean }> {
  // A first release has no range to compare — first-adoption sign-off is decided by the
  // authority kernel regardless, so there is nothing to read here.
  if (input.previousReleaseSha === null) {
    return { changedAuthorityPaths: [], rangeUnverifiable: false };
  }
  try {
    const files = await scm.getChangedFilesInRange({
      repository: input.repository,
      baseSha: input.previousReleaseSha,
      headSha: input.candidateSha,
    });
    return {
      changedAuthorityPaths: selectChangedAuthorityPaths(files.map((f) => f.path)),
      rangeUnverifiable: false,
    };
  } catch {
    return { changedAuthorityPaths: [], rangeUnverifiable: true };
  }
}

/**
 * Resolve every configured required workflow to its exact current-attempt evidence and
 * aggregate the classified states. Only runs when the candidate configuration is valid:
 * an ineligible configuration has no workflows to resolve and is handled by the
 * authority kernel. A provider fault at either the default-branch or per-workflow read
 * is classified `unverifiable`, never a silent pass.
 */
async function resolveWorkflowAggregate(
  deps: PrerequisiteResolverDeps,
  input: PrerequisiteResolutionInput,
  candidate: RepositoryReleaseConfigParse,
): Promise<RequiredWorkflowAggregate> {
  if (!candidate.ok) return aggregateRequiredWorkflows([]);

  let defaultBranch: string;
  try {
    defaultBranch = await deps.workflowRuns.resolveDefaultBranch(input.repository);
  } catch (error) {
    return aggregateRequiredWorkflows(
      candidate.config.requiredWorkflows.map((workflowPath) => ({
        workflowPath,
        state: "unverifiable" as const,
        detail: `default branch could not be resolved: ${errorDetail(error)}`,
      })),
    );
  }

  const classified: ClassifiedRequiredWorkflow[] = [];
  for (const workflowPath of candidate.config.requiredWorkflows) {
    try {
      const resolution = await deps.workflowRuns.resolveRequiredWorkflowRun({
        repository: input.repository,
        workflowPath,
        candidateSha: input.candidateSha,
        defaultBranch,
      });
      classified.push(classifyRequiredWorkflow(resolution));
    } catch (error) {
      classified.push({
        workflowPath,
        state: "unverifiable",
        detail: `workflow run could not be resolved: ${errorDetail(error)}`,
      });
    }
  }
  return aggregateRequiredWorkflows(classified);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
