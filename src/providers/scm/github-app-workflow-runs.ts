import { z } from "zod";
import type { GhApi } from "./github-app.js";
import type { WorkflowRunReader } from "./port.js";
import {
  isAcceptedWorkflowEvent,
  selectCurrentAttempt,
  type RequiredWorkflowEvidence,
  type RequiredWorkflowQuery,
  type WorkflowRunResolution,
} from "../../domain/release/required-workflow-evidence.js";

/**
 * GitHub App-backed READER for required-workflow run evidence — the narrow,
 * read-only Actions counterpart to the source reader. It resolves a configured
 * workflow PATH to the provider's workflow identity and selects the current
 * applicable run/attempt for an EXACT candidate SHA and default branch.
 *
 * Read-only, least privilege: it uses only the App's existing `Actions: read`
 * permission via two GET endpoints and NEVER dispatches, reruns, cancels, approves,
 * or otherwise mutates a workflow, run, or deployment. The exact endpoints are:
 *   - `GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}`      (identity)
 *   - `GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs` (runs)
 *
 * RESULT DISCIPLINE (design's fail-closed contract):
 *  - a genuinely-missing workflow or an empty matching-run set is `absent`;
 *  - a provider fault, incomplete pagination, malformed data, identity/path
 *    mismatch, or an ambiguous current run is `unverifiable`;
 *  - neither is ever a green or an empty-success. Identity is the workflow ID/path,
 *    never a display name or a check-run/status context.
 *
 * TRUST BOUNDARY: `workflowId`, `event`, `status`, `conclusion`, `head_sha`, and
 * `head_branch` are read from the provider — never accepted from the caller. The
 * caller supplies only Scruffy-resolved facts (config path, candidate SHA, default
 * branch), each of which is re-verified against the provider's own run fields.
 */

/** GitHub Actions list pages max at 100 items per page. */
const PER_PAGE = 100;

/**
 * Hard bound on run-listing pages. The listing is filtered to a single workflow AND
 * a single candidate SHA, so the real result is a handful of rows; exhausting this
 * many pages means a non-advancing cursor, which THROWS (→ unverifiable) rather than
 * silently truncating a partial view into a false absence.
 */
const MAX_RUN_PAGES = 10;

const WorkflowIdentity = z.object({
  id: z.number().int().positive(),
  path: z.string().min(1),
});

/**
 * One workflow-run row. `status` is required and non-null (a run always has one);
 * `conclusion` is null until completion; `head_branch` may be null on a detached
 * run. `run_attempt` is the CURRENT attempt number — a rerun increments it on the
 * same run id, so the latest attempt's status/conclusion supersede earlier ones.
 */
const WorkflowRunRow = z.object({
  id: z.number().int().positive(),
  workflow_id: z.number().int().positive(),
  run_attempt: z.number().int().positive().optional(),
  event: z.string().min(1),
  head_branch: z.string().min(1).nullable(),
  head_sha: z.string().min(1),
  status: z.string().min(1),
  conclusion: z.string().min(1).nullable().optional(),
  html_url: z.string().min(1),
});
type WorkflowRunRow = z.infer<typeof WorkflowRunRow>;

/**
 * `total_count` is the endpoint's own claim about how many runs match the filter;
 * we check the accumulated rows against it as the only available proof pagination
 * read everything rather than stopping on a truncated page.
 */
const WorkflowRunsPage = z.object({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(WorkflowRunRow),
});

export class GithubAppWorkflowRunReader implements WorkflowRunReader {
  constructor(private readonly api: GhApi) {}

  async resolveRequiredWorkflowRun(query: RequiredWorkflowQuery): Promise<WorkflowRunResolution> {
    const { owner, repo } = splitRepository(query.repository);
    if (!/^[0-9a-f]{40}$/.test(query.candidateSha)) {
      // A Scruffy-resolved candidate must be a full commit SHA; a malformed one is a
      // caller bug, not a provider state, so surface it loudly.
      throw new Error(`invalid candidate sha '${query.candidateSha}'`);
    }
    const fileName = workflowFileName(query.workflowPath);

    // ── 1. Resolve the configured PATH to a provider workflow identity ──────────
    let identity: z.infer<typeof WorkflowIdentity>;
    try {
      const res = await this.api("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}", {
        owner,
        repo,
        workflow_id: fileName,
      });
      if (res.status === 404) {
        return { kind: "absent", workflowPath: query.workflowPath };
      }
      if (res.status !== 200) {
        return unverifiable(query.workflowPath, `workflow identity returned HTTP ${res.status}`);
      }
      identity = WorkflowIdentity.parse(res.data);
    } catch (err) {
      if (statusOf(err) === 404) return { kind: "absent", workflowPath: query.workflowPath };
      return unverifiable(query.workflowPath, `workflow identity read failed: ${message(err)}`);
    }

    if (identity.path !== query.workflowPath) {
      // The basename resolved to a workflow whose stored path is not the configured
      // one — an identity mismatch we must not silently accept as the right workflow.
      return unverifiable(
        query.workflowPath,
        `resolved workflow path '${identity.path}' does not match configured '${query.workflowPath}'`,
      );
    }

    // ── 2. List this workflow's runs for the EXACT candidate SHA ────────────────
    let rows: WorkflowRunRow[];
    try {
      rows = await this.#listCandidateRuns(owner, repo, identity.id, query.candidateSha);
    } catch (err) {
      return unverifiable(query.workflowPath, `workflow runs read failed: ${message(err)}`);
    }

    // ── 3. Keep only exact-identity, exact-candidate, default-branch, accepted-event
    // runs. A run on another event/branch/sha (or a stray other workflow the filter
    // returned) is NOT this candidate's release evidence.
    const matching: RequiredWorkflowEvidence[] = rows
      .filter(
        (row) =>
          row.workflow_id === identity.id &&
          row.head_sha === query.candidateSha &&
          row.head_branch === query.defaultBranch &&
          isAcceptedWorkflowEvent(row.event),
      )
      .map((row) => toEvidence(row, identity.id, identity.path));

    // ── 4. Select the current attempt; ambiguity or emptiness is not a green ─────
    const selected = selectCurrentAttempt(matching);
    if (selected.kind === "none") {
      return { kind: "absent", workflowPath: query.workflowPath };
    }
    if (selected.kind === "ambiguous") {
      return unverifiable(
        query.workflowPath,
        `multiple distinct runs (${selected.runIds.join(", ")}) match the exact ` +
          `workflow/candidate/branch/event — current run is ambiguous`,
      );
    }
    return { kind: "resolved", evidence: selected.evidence };
  }

  /**
   * All run rows for `workflowId` at the exact `candidateSha`, paginated and
   * COMPLETE-OR-THROW. The accumulated rows are checked against the endpoint's own
   * `total_count`; a stalled cursor or an unmet count throws rather than returning a
   * partial listing that a genuine absence would be indistinguishable from.
   */
  async #listCandidateRuns(
    owner: string,
    repo: string,
    workflowId: number,
    candidateSha: string,
  ): Promise<WorkflowRunRow[]> {
    const rows: WorkflowRunRow[] = [];
    // Completeness is measured over DISTINCT run ids, which is what `total_count`
    // counts. Attempt rows for the same run are all kept for the domain's
    // current-attempt selection, but they do not inflate the count.
    const distinctRunIds = new Set<number>();
    let total: number | null = null;

    for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
      const res = await this.api(
        "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
        {
          owner,
          repo,
          workflow_id: workflowId,
          head_sha: candidateSha,
          per_page: PER_PAGE,
          page,
        },
      );
      if (res.status !== 200) {
        throw new Error(`workflow runs page ${page} returned HTTP ${res.status}`);
      }
      const parsed = WorkflowRunsPage.parse(res.data);
      total = parsed.total_count;

      for (const row of parsed.workflow_runs) {
        rows.push(row);
        distinctRunIds.add(row.id);
      }

      if (distinctRunIds.size >= total) break;
      if (parsed.workflow_runs.length === 0) {
        throw new Error(
          `workflow runs listing stalled at ${distinctRunIds.size} of ${total} (page ${page} empty)`,
        );
      }
    }

    if (total !== null && distinctRunIds.size < total) {
      throw new Error(
        `workflow runs listing read ${distinctRunIds.size} of ${total} within ${MAX_RUN_PAGES} pages`,
      );
    }
    return rows;
  }
}

/** Split `owner/name`, throwing on any other shape. */
function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo, extra] = repository.split("/");
  if (!owner || !repo || extra !== undefined) {
    throw new Error(`invalid repository '${repository}' (expected owner/name)`);
  }
  return { owner, repo };
}

/**
 * The workflow file name GitHub's per-workflow endpoint accepts (the basename), from
 * a canonical `.github/workflows/<file>` path. Throws on any other shape — the path
 * comes from the strict parser, so a non-canonical value here is a caller bug.
 */
function workflowFileName(workflowPath: string): string {
  const segments = workflowPath.split("/");
  if (
    segments.length !== 3 ||
    segments[0] !== ".github" ||
    segments[1] !== "workflows" ||
    !/^[A-Za-z0-9._-]+\.(yml|yaml)$/.test(segments[2]!)
  ) {
    throw new Error(`invalid workflow path '${workflowPath}'`);
  }
  return segments[2]!;
}

function toEvidence(
  row: WorkflowRunRow,
  workflowId: number,
  workflowPath: string,
): RequiredWorkflowEvidence {
  return {
    workflowId,
    workflowPath,
    runId: row.id,
    runAttempt: row.run_attempt ?? 1,
    event: row.event,
    // head_branch is filtered to be non-null and equal to the default branch before
    // this maps, so the assertion is a type-narrowing formality, not a new decision.
    branch: row.head_branch!,
    candidateSha: row.head_sha,
    status: row.status,
    conclusion: row.conclusion ?? null,
    url: row.html_url,
  };
}

function unverifiable(workflowPath: string, detail: string): WorkflowRunResolution {
  return { kind: "unverifiable", workflowPath, detail };
}

/** A numeric `status` off an unknown error (Octokit's RequestError carries one), or null. */
function statusOf(err: unknown): number | null {
  if (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  ) {
    return (err as { status: number }).status;
  }
  return null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
