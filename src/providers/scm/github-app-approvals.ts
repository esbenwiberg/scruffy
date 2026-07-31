import { z } from "zod";
import type { GhApi } from "./github-app.js";
import type { WorkflowApprovalHistory, WorkflowApprovalReader } from "./port.js";

/**
 * GitHub's documented workflow-run review-history entry
 * (GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals). Each entry carries
 * `state`, `comment`, `environments`, and `user` — and NOTHING that timestamps the
 * review. The documented state vocabulary is `approved | rejected | pending`; a
 * review can be pending because a required Environment still awaits a decision. We
 * parse the shape faithfully and NEVER invent a `submitted_at`/review timestamp the
 * provider does not supply. `comment` is read but not surfaced to the caller (it is
 * an internal provider diagnostic, not authority material).
 */
const ApprovalHistory = z.array(
  z.object({
    state: z.enum(["approved", "rejected", "pending"]),
    comment: z.string().optional(),
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
      })),
    );
    return { runAttempt: run.run_attempt, approvals };
  }
}
