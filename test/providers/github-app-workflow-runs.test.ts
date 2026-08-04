import { describe, expect, it, vi } from "vitest";
import { GithubAppWorkflowRunReader } from "../../src/providers/scm/github-app-workflow-runs.js";
import type { GhApi } from "../../src/providers/scm/github-app.js";
import type { RequiredWorkflowQuery } from "../../src/domain/release/required-workflow-evidence.js";

/**
 * Offline contract test for the read-only GitHub Actions workflow-run reader. A
 * stubbed `GhApi` returns recorded workflow-identity and workflow-runs shapes so the
 * exact identity/candidate/branch/event matching, the current-attempt selection, and
 * the absent-vs-unverifiable discipline are pinned without network or App credentials.
 *
 * The two endpoints under test are BOTH read-only:
 *   GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}
 *   GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs
 */

const REPO = "acme/widgets";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const BRANCH = "main";
const PATH = ".github/workflows/ci.yml";
const WORKFLOW_ID = 4242;

const QUERY: RequiredWorkflowQuery = {
  repository: REPO,
  workflowPath: PATH,
  candidateSha: SHA,
  defaultBranch: BRANCH,
};

type Call = { route: string; params: Record<string, unknown> | undefined };

const isIdentity = (r: string) => r.endsWith("/actions/workflows/{workflow_id}");
const isRuns = (r: string) => r.endsWith("/actions/workflows/{workflow_id}/runs");

/** A workflow-run row shaped like GitHub's list response. */
function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 900,
    workflow_id: WORKFLOW_ID,
    run_attempt: 1,
    event: "push",
    head_branch: BRANCH,
    head_sha: SHA,
    status: "completed",
    conclusion: "success",
    html_url: `https://github.com/${REPO}/actions/runs/900`,
    ...overrides,
  };
}

function reader(handlers: {
  identity?: () => { status: number; data: unknown };
  runs?: (call: Call) => { status: number; data: unknown };
}): { reader: GithubAppWorkflowRunReader; calls: Call[]; api: ReturnType<typeof vi.fn> } {
  const calls: Call[] = [];
  const api = vi.fn(async (route: string, params?: Record<string, unknown>) => {
    calls.push({ route, params });
    if (isIdentity(route)) {
      return (
        handlers.identity?.() ?? { status: 200, data: { id: WORKFLOW_ID, path: PATH } }
      );
    }
    if (isRuns(route)) {
      return handlers.runs?.({ route, params }) ?? { status: 200, data: { total_count: 0, workflow_runs: [] } };
    }
    throw new Error(`unexpected route ${route}`);
  });
  return { reader: new GithubAppWorkflowRunReader(api as unknown as GhApi), calls, api };
}

describe("required workflow run identity", () => {
  it("binds evidence to exact workflow id/path, candidate sha, default branch, and accepted event", async () => {
    const { reader: r, calls } = reader({
      runs: () => ({ status: 200, data: { total_count: 1, workflow_runs: [run()] } }),
    });

    const result = await r.resolveRequiredWorkflowRun(QUERY);

    expect(result).toEqual({
      kind: "resolved",
      evidence: {
        workflowId: WORKFLOW_ID,
        workflowPath: PATH,
        runId: 900,
        runAttempt: 1,
        event: "push",
        branch: BRANCH,
        candidateSha: SHA,
        status: "completed",
        conclusion: "success",
        url: `https://github.com/${REPO}/actions/runs/900`,
      },
    });
    // Identity is resolved through the workflow FILE NAME, and runs are read from the
    // workflow-scoped endpoint filtered by the exact candidate sha — never a name.
    expect(calls.find((c) => isIdentity(c.route))?.params).toMatchObject({
      owner: "acme",
      repo: "widgets",
      workflow_id: "ci.yml",
    });
    expect(calls.find((c) => isRuns(c.route))?.params).toMatchObject({
      workflow_id: WORKFLOW_ID,
      head_sha: SHA,
    });
  });

  it("resists display-name collision: two workflows share a name, only the configured path/id resolves", async () => {
    // Both workflows are named "CI"; the runs endpoint is scoped to the resolved id,
    // and any stray row from a DIFFERENT workflow id is discarded. A name-based
    // implementation would match the collided sibling here.
    const { reader: r } = reader({
      identity: () => ({ status: 200, data: { id: WORKFLOW_ID, name: "CI", path: PATH } }),
      runs: () => ({
        status: 200,
        data: {
          total_count: 2,
          workflow_runs: [
            run({ id: 901, workflow_id: 5555, event: "push" }), // sibling "CI", wrong id
            run({ id: 902, workflow_id: WORKFLOW_ID, event: "push" }),
          ],
        },
      }),
    });

    const result = await r.resolveRequiredWorkflowRun(QUERY);

    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.evidence.runId).toBe(902);
      expect(result.evidence.workflowId).toBe(WORKFLOW_ID);
    }
  });

  it("reports absent when the identity resolves but no run matches sha/branch/event", async () => {
    const { reader: r } = reader({
      runs: () => ({
        status: 200,
        data: {
          total_count: 3,
          workflow_runs: [
            run({ id: 1, head_sha: OTHER_SHA }), // wrong candidate
            run({ id: 2, head_branch: "feature" }), // wrong branch
            run({ id: 3, event: "pull_request" }), // unaccepted event
          ],
        },
      }),
    });

    expect(await r.resolveRequiredWorkflowRun(QUERY)).toEqual({ kind: "absent", workflowPath: PATH });
  });

  it("reports absent (not unverifiable) when the workflow file has no registered workflow", async () => {
    const { reader: r } = reader({ identity: () => ({ status: 404, data: {} }) });
    expect(await r.resolveRequiredWorkflowRun(QUERY)).toEqual({ kind: "absent", workflowPath: PATH });
  });

  it("is unverifiable when the resolved path does not match the configured path", async () => {
    const { reader: r } = reader({
      identity: () => ({ status: 200, data: { id: WORKFLOW_ID, path: ".github/workflows/other.yml" } }),
    });
    const result = await r.resolveRequiredWorkflowRun(QUERY);
    expect(result.kind).toBe("unverifiable");
  });

  it("throws on a malformed candidate sha — a caller bug, not a provider state", async () => {
    const { reader: r } = reader({});
    await expect(
      r.resolveRequiredWorkflowRun({ ...QUERY, candidateSha: "not-a-sha" }),
    ).rejects.toThrow(/candidate sha/);
  });
});

describe("required workflow rerun selection", () => {
  it("selects the current attempt: a pending rerun supersedes an earlier success", async () => {
    // Same run id, two attempts: attempt 1 succeeded, attempt 2 is in progress. The
    // current attempt (2, pending) must win — a "pick any successful attempt"
    // implementation would wrongly resolve the stale green attempt 1.
    const { reader: r } = reader({
      runs: () => ({
        status: 200,
        data: {
          total_count: 1,
          workflow_runs: [
            run({ id: 900, run_attempt: 2, status: "in_progress", conclusion: null }),
            run({ id: 900, run_attempt: 1, status: "completed", conclusion: "success" }),
          ],
        },
      }),
    });

    const result = await r.resolveRequiredWorkflowRun(QUERY);

    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.evidence.runAttempt).toBe(2);
      expect(result.evidence.status).toBe("in_progress");
      expect(result.evidence.conclusion).toBeNull();
    }
  });

  it("selects the current attempt: a failed rerun supersedes an earlier success", async () => {
    const { reader: r } = reader({
      runs: () => ({
        status: 200,
        data: {
          total_count: 1,
          workflow_runs: [
            run({ id: 900, run_attempt: 1, status: "completed", conclusion: "success" }),
            run({ id: 900, run_attempt: 3, status: "completed", conclusion: "failure" }),
          ],
        },
      }),
    });

    const result = await r.resolveRequiredWorkflowRun(QUERY);
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.evidence.runAttempt).toBe(3);
      expect(result.evidence.conclusion).toBe("failure");
    }
  });

  it("is unverifiable when two DISTINCT runs match — the current run is ambiguous", async () => {
    const { reader: r } = reader({
      runs: () => ({
        status: 200,
        data: {
          total_count: 2,
          workflow_runs: [
            run({ id: 900, event: "push" }),
            run({ id: 901, event: "workflow_dispatch" }),
          ],
        },
      }),
    });

    const result = await r.resolveRequiredWorkflowRun(QUERY);
    expect(result.kind).toBe("unverifiable");
    if (result.kind === "unverifiable") expect(result.detail).toMatch(/ambiguous/);
  });

  it("maps a non-2xx runs response and incomplete pagination to unverifiable, never absent/green", async () => {
    const fault = reader({ runs: () => ({ status: 500, data: {} }) });
    expect((await fault.reader.resolveRequiredWorkflowRun(QUERY)).kind).toBe("unverifiable");

    // total_count claims one more run than the page delivers, and the next page is
    // empty: the listing is incomplete and must not read as a genuine absence.
    const truncated = reader({
      runs: () => ({ status: 200, data: { total_count: 5, workflow_runs: [] } }),
    });
    expect((await truncated.reader.resolveRequiredWorkflowRun(QUERY)).kind).toBe("unverifiable");
  });
});
