import { z } from "zod";
import { CiEvidence, PullRequestObservation } from "../../domain/fixes/lifecycle.js";
import type { ExternalIssueObservation, ScmLifecycleReader } from "./port.js";
import type { GhApi } from "./github-app.js";

/**
 * GitHub App-backed READ adapter for the fix lifecycle.
 *
 * Separate class from `GithubAppScmWriter` because it needs no write scope: it
 * observes what humans and the repository's own CI did. Every response is
 * schema-parsed — a shape we did not expect must never be interpreted as "no CI"
 * or "not merged", both of which would silently advance a finding's state in the
 * wrong direction.
 *
 * CI is read from BOTH surfaces GitHub offers for a commit:
 *  - `GET /repos/{repo}/commits/{sha}/check-runs` (GitHub Actions and Apps), and
 *  - `GET /repos/{repo}/commits/{sha}/status` (legacy combined statuses),
 * because a repository may use either or both, and reading only one would report
 * a repository with the other as having no CI at all. Both are keyed by the sha
 * the caller asked about, which is what makes the "never carry green CI from an
 * earlier head" rule enforceable rather than aspirational.
 */

const PullDetail = z.object({
  number: z.number().int().positive(),
  html_url: z.string().min(1),
  head: z.object({ sha: z.string().min(1) }),
  draft: z.boolean().optional(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean().optional(),
  merge_commit_sha: z.string().min(1).nullable().optional(),
});

const CheckRunsForCommit = z.object({
  check_runs: z.array(
    z.object({
      name: z.string().min(1),
      status: z.enum(["queued", "in_progress", "completed"]),
      conclusion: z.string().nullable().optional(),
    }),
  ),
});

const CombinedStatus = z.object({
  statuses: z.array(
    z.object({
      context: z.string().min(1),
      state: z.enum(["error", "failure", "pending", "success"]),
    }),
  ),
});

const GitRef = z.object({ object: z.object({ sha: z.string().min(1) }) });

const IssueState = z.object({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  state_reason: z.string().nullable().optional(),
  closed_by: z.object({ login: z.string().min(1) }).nullable().optional(),
});

/** GitHub's per-page maximum for the check-run listing. */
const CHECK_RUN_PAGE_SIZE = 100;

export interface GithubAppLifecycleReaderOptions {
  api: GhApi;
}

export class GithubAppLifecycleReader implements ScmLifecycleReader {
  readonly #api: GhApi;

  constructor(options: GithubAppLifecycleReaderOptions) {
    this.#api = options.api;
  }

  /**
   * Current PR state. A 404 returns null rather than throwing: a PR a human
   * deleted (or that lives in a repository we lost access to) is a fact the
   * reconciler must be able to record, not an error to retry forever.
   *
   * `merged` is read from the single-PR route, which reports it authoritatively.
   * A `merge_commit_sha` on an unmerged PR is GitHub's *test-merge* commit, so it
   * is only carried through when `merged` is true — otherwise we would verify
   * against a throwaway commit that is on no branch.
   */
  async getPullRequest(repository: string, number: number): Promise<PullRequestObservation | null> {
    let data: unknown;
    try {
      data = (await this.#api(`GET /repos/${repository}/pulls/${number}`)).data;
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }
    const pull = this.#parse(PullDetail, data, `pull #${number}`);
    const merged = pull.merged ?? false;
    return PullRequestObservation.parse({
      number: pull.number,
      url: pull.html_url,
      headSha: pull.head.sha,
      draft: pull.draft ?? false,
      state: pull.state,
      merged,
      mergeCommitSha: merged ? (pull.merge_commit_sha ?? null) : null,
    });
  }

  /** Check runs AND combined statuses for exactly `sha`. */
  async getCiEvidence(repository: string, sha: string): Promise<CiEvidence> {
    const runs = await this.#api(`GET /repos/${repository}/commits/${sha}/check-runs`, {
      filter: "latest",
      per_page: CHECK_RUN_PAGE_SIZE,
    });
    const combined = await this.#api(`GET /repos/${repository}/commits/${sha}/status`, {
      per_page: CHECK_RUN_PAGE_SIZE,
    });
    return CiEvidence.parse({
      sha,
      checkRuns: this.#parse(CheckRunsForCommit, runs.data, `check runs for ${sha}`).check_runs.map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion ?? null,
      })),
      statuses: this.#parse(CombinedStatus, combined.data, `combined status for ${sha}`).statuses,
    });
  }

  /** Immutable head sha of a branch, or null when the branch does not exist. */
  async getBranchHead(repository: string, branch: string): Promise<string | null> {
    try {
      const ref = await this.#api(`GET /repos/${repository}/git/ref/heads/${branch}`);
      return this.#parse(GitRef, ref.data, `git ref ${branch}`).object.sha;
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }
  }

  /**
   * Current issue state plus whatever the provider will tell us about WHO closed
   * it and WHY. Both are nullable and stay nullable: GitHub omits `closed_by` in
   * some flows, and inventing an actor to fill the field would fabricate an audit
   * record. A dismissal with an unknown actor is honest; a wrong one is not.
   */
  async getIssueState(repository: string, number: number): Promise<ExternalIssueObservation | null> {
    let data: unknown;
    try {
      data = (await this.#api(`GET /repos/${repository}/issues/${number}`)).data;
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }
    const issue = this.#parse(IssueState, data, `issue #${number}`);
    return {
      number: issue.number,
      state: issue.state,
      stateReason: issue.state_reason ?? null,
      closedBy: issue.closed_by?.login ?? null,
    };
  }

  #parse<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new Error(`github-app: unexpected ${what} response shape: ${parsed.error.message}`);
    return parsed.data;
  }
}

/** A numeric `status` off an unknown error (Octokit's RequestError carries one), or null. */
function statusOf(err: unknown): number | null {
  if (typeof err === "object" && err !== null && "status" in err && typeof (err as { status: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return null;
}
