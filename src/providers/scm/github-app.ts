import { z } from "zod";
import type {
  CheckRunInput,
  CheckRunResult,
  PullRequestEdit,
  PullRequestInput,
  PullRequestResult,
  ScmWriter,
} from "./port.js";

/**
 * GitHub App-backed WRITER — the separately, narrowly privileged effects
 * credential ADR-0001 requires. Where the gh-cli adapter reuses a developer's
 * user session (read + write on one credential, statuses only), this adapter
 * authenticates as a GitHub App installation whose permissions are scoped to
 * exactly what the effects component performs: `checks:write` (check runs),
 * `contents:write` (fix branches/commits), `pull_requests:write` (fix PRs).
 *
 * It writes REAL check-runs — which, unlike commit statuses, carry a native
 * `neutral` conclusion (no neutral→pending fudge), a summary body, and an
 * `external_id` we can key idempotency on exactly as the port specifies.
 *
 * ERROR DISCIPLINE: every API failure throws. The effects dispatcher treats a
 * throw as a transient failure (retry, then dead-letter) — nothing is silently
 * dropped, and a fault can never masquerade as a successful write.
 */

/**
 * Minimal request transport, injected for tests. The default implementation
 * (see `github-app-auth.ts`) wraps `@octokit/request` with App-installation
 * auth. Contract: resolves `{ status, data }` on 2xx, REJECTS on any non-2xx
 * with an error carrying a numeric `status` where GitHub supplied one.
 */
export type GhApi = (route: string, params?: Record<string, unknown>) => Promise<{ status: number; data: unknown }>;

/** GitHub caps the contents API at 1 MiB; beyond it `content` comes back empty
 * with `encoding: "none"`. We must refuse to "edit" that, not corrupt the file. */
const CONTENTS_ENCODING = "base64";

// ── Response schemas (external boundary — parse, don't trust) ────────────────

const CheckRunsList = z.object({
  check_runs: z.array(z.object({ id: z.number(), external_id: z.string().nullable().optional() })),
});

const CreatedCheckRun = z.object({ id: z.number() });

const RepoInfo = z.object({ default_branch: z.string().min(1) });

const PullsList = z.array(z.object({ number: z.number() }));

const CreatedPull = z.object({ number: z.number() });

const GitRef = z.object({ object: z.object({ sha: z.string().min(1) }) });

const FileContents = z.object({
  content: z.string(),
  encoding: z.string(),
  sha: z.string().min(1),
});

export interface GithubAppScmWriterOptions {
  api: GhApi;
}

export class GithubAppScmWriter implements ScmWriter {
  readonly #api: GhApi;

  constructor(options: GithubAppScmWriterOptions) {
    this.#api = options.api;
  }

  // ── Check runs ──────────────────────────────────────────────────────────────

  /**
   * Idempotent on (subject, externalId), the port's canonical key: list the
   * commit's check runs under this name, match `external_id` exactly, PATCH the
   * match or POST a new run. `created` is exact here (unlike the status adapter).
   */
  async upsertCheckRun(input: CheckRunInput): Promise<CheckRunResult> {
    const { repository, commitSha } = input.subject;

    const listed = await this.#api(`GET /repos/${repository}/commits/${commitSha}/check-runs`, {
      check_name: input.name,
      filter: "all",
      per_page: 100,
    });
    const existing = this.#parse(CheckRunsList, listed.data, "check-runs list").check_runs.find(
      (run) => run.external_id === input.externalId,
    );

    const body = {
      name: input.name,
      head_sha: commitSha,
      external_id: input.externalId,
      status: "completed",
      conclusion: input.conclusion,
      output: { title: input.title, summary: input.summary },
    };

    if (existing) {
      await this.#api(`PATCH /repos/${repository}/check-runs/${existing.id}`, body);
      return { id: String(existing.id), created: false };
    }
    const created = await this.#api(`POST /repos/${repository}/check-runs`, body);
    return { id: String(this.#parse(CreatedCheckRun, created.data, "created check-run").id), created: true };
  }

  // ── Fix pull requests ───────────────────────────────────────────────────────

  /**
   * Idempotent on externalId via the deterministic head branch (the branch IS
   * the idempotency key — see nightly's fixBranch). The flow is crash-resumable
   * at every step:
   *
   *  1. a PR (any state) already exists for the head branch → done, created:false
   *     (a human-closed fix PR is a human decision; we do not re-open or nag);
   *  2. ensure the branch exists, created from the reviewed subject sha;
   *  3. apply the line edits ONLY if the branch still points at the subject sha —
   *     a branch that has advanced means a previous attempt already committed the
   *     edits (deterministic branches are single-purpose), so re-applying them to
   *     the already-fixed file would corrupt it;
   *  4. open the PR against `baseBranch` (the branch nightly reviewed), falling
   *     back to the repository default branch; a 422 duplicate race resolves by
   *     re-listing.
   *
   * NEVER merges. The PR is a proposal validated by the target repo's own CI.
   */
  async openPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    const { repository, commitSha } = input.subject;
    const owner = repository.split("/")[0];

    const existing = await this.#findPullByHead(repository, `${owner}:${input.branch}`);
    if (existing !== null) return { number: existing, created: false };

    const refSha = await this.#branchHead(repository, input.branch);
    if (refSha === null) {
      await this.#api(`POST /repos/${repository}/git/refs`, {
        ref: `refs/heads/${input.branch}`,
        sha: commitSha,
      });
    }

    if (refSha === null || refSha === commitSha) {
      await this.#commitEdits(repository, input.branch, input.edits, input.title);
    }

    const base = input.baseBranch ?? (await this.#defaultBranch(repository));
    try {
      const created = await this.#api(`POST /repos/${repository}/pulls`, {
        title: input.title,
        body: input.body,
        head: input.branch,
        base,
      });
      return { number: this.#parse(CreatedPull, created.data, "created pull").number, created: true };
    } catch (err) {
      // 422 = "a pull request already exists" — a concurrent/crashed attempt won
      // the race. Re-list and return it; anything else is a real failure.
      if (statusOf(err) !== 422) throw err;
      const raced = await this.#findPullByHead(repository, `${owner}:${input.branch}`);
      if (raced === null) throw err;
      return { number: raced, created: false };
    }
  }

  async #commitEdits(repository: string, branch: string, edits: readonly PullRequestEdit[], title: string): Promise<void> {
    // One contents-API commit per file: group the edits by path.
    const byPath = new Map<string, PullRequestEdit[]>();
    for (const edit of edits) {
      const group = byPath.get(edit.path) ?? [];
      group.push(edit);
      byPath.set(edit.path, group);
    }

    for (const [path, fileEdits] of byPath) {
      const fetched = await this.#api(`GET /repos/${repository}/contents/${path}`, { ref: branch });
      const file = this.#parse(FileContents, fetched.data, `contents of ${path}`);
      if (file.encoding !== CONTENTS_ENCODING) {
        // >1 MiB files come back with encoding "none" and empty content. Editing
        // that would silently truncate the file — refuse loudly instead.
        throw new Error(`contents of ${path} returned encoding '${file.encoding}' (file too large?) — cannot apply edits safely`);
      }
      const updated = applyEdits(Buffer.from(file.content, "base64").toString("utf8"), fileEdits);
      await this.#api(`PUT /repos/${repository}/contents/${path}`, {
        message: title,
        content: Buffer.from(updated, "utf8").toString("base64"),
        sha: file.sha,
        branch,
      });
    }
  }

  /** PR number for a head branch (ANY state — a closed fix PR is a human decision), or null. */
  async #findPullByHead(repository: string, head: string): Promise<number | null> {
    const listed = await this.#api(`GET /repos/${repository}/pulls`, { head, state: "all", per_page: 1 });
    const pulls = this.#parse(PullsList, listed.data, "pulls list");
    return pulls.length > 0 ? pulls[0]!.number : null;
  }

  /** Head sha of a branch, or null when the branch does not exist (404). */
  async #branchHead(repository: string, branch: string): Promise<string | null> {
    try {
      const ref = await this.#api(`GET /repos/${repository}/git/ref/heads/${branch}`);
      return this.#parse(GitRef, ref.data, "git ref").object.sha;
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }
  }

  async #defaultBranch(repository: string): Promise<string> {
    const info = await this.#api(`GET /repos/${repository}`);
    return this.#parse(RepoInfo, info.data, "repo info").default_branch;
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

/**
 * Apply line-scoped edits to file content. Pure; exported for tests.
 *
 * Line numbers are 1-based and refer to the ORIGINAL content (the file at the
 * reviewed subject revision), so edits are validated against it as a set —
 * overlapping ranges are ambiguous and rejected — then applied bottom-up so
 * earlier replacements cannot shift later line numbers.
 */
export function applyEdits(content: string, edits: readonly PullRequestEdit[]): string {
  const lines = content.split("\n");

  const sorted = [...edits].sort((a, b) => a.startLine - b.startLine);
  for (const [i, edit] of sorted.entries()) {
    if (edit.endLine < edit.startLine) {
      throw new Error(`edit for ${edit.path} has endLine ${edit.endLine} < startLine ${edit.startLine}`);
    }
    if (edit.startLine < 1 || edit.endLine > lines.length) {
      throw new Error(`edit for ${edit.path} lines ${edit.startLine}-${edit.endLine} is out of range (file has ${lines.length} lines)`);
    }
    const previous = sorted[i - 1];
    if (previous && edit.startLine <= previous.endLine) {
      throw new Error(`edits for ${edit.path} overlap (lines ${previous.startLine}-${previous.endLine} and ${edit.startLine}-${edit.endLine})`);
    }
  }

  for (const edit of [...sorted].reverse()) {
    lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...edit.replacement.split("\n"));
  }
  return lines.join("\n");
}
