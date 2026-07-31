import { describe, expect, it, vi } from "vitest";
import { GithubAppWorkflowApprovalReader } from "../../src/providers/scm/github-app-approvals.js";

describe("GithubAppWorkflowApprovalReader", () => {
  it("reads and normalizes protected-Environment approval history without writing", async () => {
    const api = vi.fn().mockImplementation(async (route: string) =>
      route.endsWith("/approvals")
        ? {
            status: 200,
            data: [
              {
                state: "approved",
                submitted_at: "2026-07-31T00:00:00.000Z",
                user: { login: "release-owner", id: 789 },
                environments: [{ name: "scruffy-production-signoff" }],
              },
            ],
          }
        : { status: 200, data: { run_attempt: 2 } },
    );
    const reader = new GithubAppWorkflowApprovalReader(api);
    await expect(reader.getWorkflowRunApprovals("acme/widgets", "456")).resolves.toEqual({
      runAttempt: 2,
      approvals: [
        {
          environment: "scruffy-production-signoff",
          state: "approved",
          reviewer: { login: "release-owner", id: "789" },
          reviewedAt: "2026-07-31T00:00:00.000Z",
        },
      ],
    });
    expect(api).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/actions/runs/{run_id}", {
      owner: "acme",
      repo: "widgets",
      run_id: 456,
    });
    expect(api).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals", {
      owner: "acme",
      repo: "widgets",
      run_id: 456,
    });
  });

  it("throws on malformed, partial, or failed provider responses", async () => {
    await expect(
      new GithubAppWorkflowApprovalReader(
        vi.fn().mockResolvedValue({ status: 403, data: {} }),
      ).getWorkflowRunApprovals("acme/widgets", "456"),
    ).rejects.toThrow(/HTTP 403\/403/);
    const malformed = vi
      .fn()
      .mockImplementation(async (route: string) =>
        route.endsWith("/approvals")
          ? { status: 200, data: [{}] }
          : { status: 200, data: { run_attempt: 1 } },
      );
    await expect(
      new GithubAppWorkflowApprovalReader(malformed).getWorkflowRunApprovals("acme/widgets", "456"),
    ).rejects.toThrow();
  });
});
