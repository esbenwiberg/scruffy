import { z } from "zod";
import type { GhApi } from "./github-app.js";
import type { WorkflowApprovalHistory, WorkflowApprovalReader } from "./port.js";

const ApprovalHistory = z.array(
  z.object({
    state: z.enum(["approved", "rejected"]),
    submitted_at: z.string().datetime(),
    user: z.object({
      login: z.string().min(1),
      id: z.number().int().positive().safe(),
    }),
    environments: z.array(z.object({ name: z.string().min(1) })).min(1),
  }),
);

/**
 * Least-privileged GitHub App reader for protected-Environment review history.
 * Requires repository Actions: read. It never approves, rejects, dispatches, or
 * mutates a workflow/deployment.
 */
export class GithubAppWorkflowApprovalReader implements WorkflowApprovalReader {
  constructor(private readonly api: GhApi) {}

  async getWorkflowRunApprovals(
    repository: string,
    runId: string,
  ): Promise<WorkflowApprovalHistory> {
    const [owner, repo, extra] = repository.split("/");
    if (!owner || !repo || extra !== undefined || !/^\d+$/.test(runId)) {
      throw new Error("invalid repository or workflow run id");
    }
    const params = { owner, repo, run_id: Number(runId) };
    const [runResponse, approvalResponse] = await Promise.all([
      this.api("GET /repos/{owner}/{repo}/actions/runs/{run_id}", params),
      this.api("GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals", params),
    ]);
    if (runResponse.status !== 200 || approvalResponse.status !== 200) {
      throw new Error(
        `GitHub workflow run/approvals returned HTTP ${runResponse.status}/${approvalResponse.status}`,
      );
    }
    const run = z.object({ run_attempt: z.number().int().positive() }).parse(runResponse.data);
    const approvals = ApprovalHistory.parse(approvalResponse.data).flatMap((approval) =>
      approval.environments.map((environment) => ({
        environment: environment.name,
        state: approval.state,
        reviewer: { login: approval.user.login, id: String(approval.user.id) },
        reviewedAt: approval.submitted_at,
      })),
    );
    return { runAttempt: run.run_attempt, approvals };
  }
}
