import { describe, expect, it, vi } from "vitest";
import { GithubAppWorkflowApprovalReader } from "../../src/providers/scm/github-app-approvals.js";

describe("GithubAppWorkflowApprovalReader", () => {
  it("parses GitHub's documented workflow review history", async () => {
    // Exactly the documented response shape: state, comment, environments, user —
    // and NO submitted_at / review timestamp. Coverage includes approved, rejected,
    // AND pending, so a valid response is neither rejected wholesale nor coerced.
    const api = vi.fn().mockImplementation(async (route: string) =>
      route.endsWith("/approvals")
        ? {
            status: 200,
            data: [
              {
                state: "approved",
                comment: "Accepting the controlled exception.",
                user: { login: "release-owner", id: 789 },
                environments: [{ name: "scruffy-production-signoff" }],
              },
              {
                state: "rejected",
                comment: "Not this run.",
                user: { login: "auditor", id: 1000 },
                environments: [{ name: "scruffy-production-signoff" }],
              },
              {
                state: "pending",
                comment: "",
                user: { login: "second-reviewer", id: 1001 },
                environments: [{ name: "scruffy-production-signoff" }],
              },
            ],
          }
        : { status: 200, data: { run_attempt: 2 } },
    );
    const reader = new GithubAppWorkflowApprovalReader(api);
    const history = await reader.getWorkflowRunApprovals("acme/widgets", "456");
    expect(history).toEqual({
      runAttempt: 2,
      approvals: [
        {
          environment: "scruffy-production-signoff",
          state: "approved",
          reviewer: { login: "release-owner", id: "789" },
        },
        {
          environment: "scruffy-production-signoff",
          state: "rejected",
          reviewer: { login: "auditor", id: "1000" },
        },
        {
          environment: "scruffy-production-signoff",
          state: "pending",
          reviewer: { login: "second-reviewer", id: "1001" },
        },
      ],
    });
    // The normalized entry never carries an invented provider review timestamp.
    for (const approval of history.approvals) {
      expect(approval).not.toHaveProperty("reviewedAt");
      expect(approval).not.toHaveProperty("submitted_at");
    }
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
    // An unknown state outside GitHub's documented vocabulary still fails closed.
    const unknownState = vi
      .fn()
      .mockImplementation(async (route: string) =>
        route.endsWith("/approvals")
          ? {
              status: 200,
              data: [
                {
                  state: "escalated",
                  user: { login: "x", id: 1 },
                  environments: [{ name: "scruffy-production-signoff" }],
                },
              ],
            }
          : { status: 200, data: { run_attempt: 1 } },
      );
    await expect(
      new GithubAppWorkflowApprovalReader(unknownState).getWorkflowRunApprovals(
        "acme/widgets",
        "456",
      ),
    ).rejects.toThrow();
  });
});
