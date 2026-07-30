import { z } from "zod";
import { withIssueMarker } from "../../domain/findings/work-publication.js";
import { commitCarriesProposal, fixCommitMessage } from "../../domain/fixes/delivery.js";
import type {
  CheckRunInput,
  CheckRunResult,
  IssueLinkInput,
  IssueLinkResult,
  IssueUpsertInput,
  IssueUpsertResult,
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
 * `contents:write` (fix branches/commits), `pull_requests:write` (fix PRs),
 * `issues:write` (nightly parent/child work items).
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

/**
 * A pull request as GitHub returns it on the list and create routes. `draft` is
 * read back rather than assumed from the request: whether the PR a human sees is
 * marked draft is provider truth, and a repository/plan that refuses drafts must
 * not leave us recording one.
 */
const PullSummary = z.object({
  number: z.number().int().positive(),
  html_url: z.string().min(1),
  draft: z.boolean().optional(),
  head: z.object({ sha: z.string().min(1) }),
});

const PullsList = z.array(PullSummary);

const GitRef = z.object({ object: z.object({ sha: z.string().min(1) }) });

/** A git commit object. `message` carries the fix-proposal manifest trailer. */
const GitCommit = z.object({
  sha: z.string().min(1),
  message: z.string(),
  tree: z.object({ sha: z.string().min(1) }),
});

const CreatedBlob = z.object({ sha: z.string().min(1) });

const CreatedTree = z.object({ sha: z.string().min(1) });

/** One level of a git tree. Walked per path segment to recover a blob's mode. */
const GitTree = z.object({
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string().min(1),
      type: z.string().min(1),
      sha: z.string().min(1).nullable().optional(),
    }),
  ),
});

const FileContents = z.object({
  content: z.string(),
  encoding: z.string(),
  sha: z.string().min(1),
});

/**
 * An issue as GitHub returns it. `pull_request` is present on PRs, which the
 * `/issues` list endpoint mixes in with real issues — we must filter them out or a
 * marker-bearing PR body would be mistaken for a published work item.
 */
const IssueResponse = z.object({
  number: z.number().int().positive(),
  /**
   * The issue DATABASE id — a different value from `number`, and the one the
   * native sub-issue endpoint takes. Constrained here rather than only at the
   * attach call so a nonsense id fails at the boundary that produced it.
   */
  id: z.number().int().positive(),
  html_url: z.string().min(1),
  body: z.string().nullable().optional(),
  pull_request: z.unknown().optional(),
});
type IssueResponse = z.infer<typeof IssueResponse>;

const IssueList = z.array(IssueResponse);

const SubIssueList = z.array(z.object({ id: z.number().int().positive(), number: z.number().int().positive() }));

/** Page size for issue/sub-issue listings. GitHub's maximum. */
const ISSUE_PAGE_SIZE = 100;

/**
 * Hard page cap on the marker lookup (100 issues per page). The lookup normally
 * stops at the first short page, so this only bites a repository with thousands of
 * Scruffy-labelled issues — where exhausting the cap makes the adapter THROW
 * rather than fall through to a create. A duplicate parent issue is a far worse
 * outcome than a loud, retryable failure that an operator can act on.
 */
const ISSUE_LOOKUP_MAX_PAGES = 50;

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
   * Idempotent on the candidate-bound head branch (`fixProposalBranch`), which is
   * derived from the FULL fix proposal identity, so the same defect at the same
   * location on a later candidate is a different branch and cannot be mistaken
   * for delivery of the old one.
   *
   * The flow is crash-resumable at every step:
   *
   *  1. a PR (any state) already exists for this branch → done, `created: false`
   *     (a human-closed fix PR is a human decision; we do not re-open or nag);
   *  2. the branch does not exist → build the patch as ONE commit whose parent is
   *     the reviewed candidate sha and whose message carries the proposal manifest,
   *     then create the ref pointing at it;
   *  3. the branch DOES exist → the only sanctioned way to conclude "our patch is
   *     already there" is that its head commit declares this exact proposal id.
   *     A branch that merely advanced proves nothing, so anything else FAILS
   *     rather than opening a PR that misrepresents what it contains;
   *  4. open the PR against `baseBranch` (the branch nightly reviewed), falling
   *     back to the repository default branch, as a draft when asked; a 422
   *     duplicate race resolves by re-listing.
   *
   * NEVER merges. The PR is a proposal validated by the target repo's own CI.
   */
  async openPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    const { repository, commitSha } = input.subject;
    const owner = repository.split("/")[0];
    const head = `${owner}:${input.branch}`;

    const existing = await this.#findPullByHead(repository, head);
    if (existing !== null) return { ...existing, created: false };

    const refSha = await this.#branchHead(repository, input.branch);
    if (refSha === null) {
      const commit = await this.#buildProposalCommit(repository, input);
      try {
        await this.#api(`POST /repos/${repository}/git/refs`, { ref: `refs/heads/${input.branch}`, sha: commit });
      } catch (err) {
        // 422 = the ref appeared under us (a concurrent attempt). Re-verify the
        // manifest instead of force-updating: whatever is there now must still be
        // provably this proposal.
        if (statusOf(err) !== 422) throw err;
        await this.#requireProposalOnBranch(repository, input);
      }
    } else {
      await this.#requireProposalOnBranch(repository, input);
    }

    const base = input.baseBranch ?? (await this.#defaultBranch(repository));
    try {
      const created = await this.#api(`POST /repos/${repository}/pulls`, {
        title: input.title,
        body: input.body,
        head: input.branch,
        base,
        draft: input.draft,
      });
      return { ...this.#toPullResult(this.#parse(PullSummary, created.data, "created pull")), created: true };
    } catch (err) {
      // 422 = "a pull request already exists" — a concurrent/crashed attempt won
      // the race. Re-list and return it; anything else is a real failure.
      if (statusOf(err) !== 422) throw err;
      const raced = await this.#findPullByHead(repository, head);
      if (raced === null) throw err;
      return { ...raced, created: false };
    }
  }

  /**
   * Assert that `input.branch`'s head commit declares delivery of exactly
   * `input.proposalId`, throwing otherwise.
   *
   * This replaces the old "the branch advanced, so a previous attempt must have
   * committed the edits" inference. That inference is unsound in both directions:
   * a partially-written older attempt, a human commit, or a rebase all advance the
   * branch without containing our patch — and acting on it opened a PR whose body
   * described edits that were not in it. Failing here is loud, retryable, and
   * leaves the child work item visibly undelivered.
   */
  async #requireProposalOnBranch(repository: string, input: PullRequestInput): Promise<void> {
    const refSha = await this.#branchHead(repository, input.branch);
    if (refSha === null) {
      throw new Error(`github-app: branch ${input.branch} disappeared while delivering ${input.proposalId}`);
    }
    const commit = await this.#commit(repository, refSha);
    if (!commitCarriesProposal(commit.message, input.proposalId)) {
      throw new Error(
        `github-app: branch ${input.branch} is at ${refSha}, which does not declare fix proposal ` +
          `${input.proposalId} — refusing to open a pull request that would misrepresent its contents`,
      );
    }
  }

  /**
   * Build the whole proposal as ONE commit and return its sha. Nothing is written
   * to a branch until every edit has been validated and the complete tree exists,
   * so there is no observable half-applied state:
   *
   *  1. read each touched path's full content AT THE REVIEWED SHA (never at the
   *     branch — the point is to anchor to what was actually analysed);
   *  2. verify every supplied `expectedOriginal` against those exact lines. A
   *     mismatch is a stale or hallucinated preimage and rejects the proposal;
   *  3. apply the edits per file (`applyEdits` rejects overlaps/out-of-range);
   *  4. write one blob per file, preserving the file's existing mode so a fix
   *     never silently un-executables a script;
   *  5. one tree on top of the reviewed commit's tree, one commit with the
   *     reviewed sha as its single parent and the manifest trailer in its message.
   */
  async #buildProposalCommit(repository: string, input: PullRequestInput): Promise<string> {
    const { commitSha } = input.subject;
    const parent = await this.#commit(repository, commitSha);

    const byPath = new Map<string, PullRequestEdit[]>();
    for (const edit of input.edits) {
      const group = byPath.get(edit.path) ?? [];
      group.push(edit);
      byPath.set(edit.path, group);
    }

    const entries: { path: string; mode: string; type: "blob"; sha: string }[] = [];
    for (const [path, fileEdits] of byPath) {
      const fetched = await this.#api(`GET /repos/${repository}/contents/${path}`, { ref: commitSha });
      const file = this.#parse(FileContents, fetched.data, `contents of ${path}`);
      if (file.encoding !== CONTENTS_ENCODING) {
        // >1 MiB files come back with encoding "none" and empty content. Editing
        // that would silently truncate the file — refuse loudly instead.
        throw new Error(`contents of ${path} returned encoding '${file.encoding}' (file too large?) — cannot apply edits safely`);
      }
      const original = Buffer.from(file.content, "base64").toString("utf8");
      verifyPreimages(original, fileEdits, commitSha);
      const updated = applyEdits(original, fileEdits);

      const mode = await this.#blobMode(repository, parent.tree.sha, path);
      const blob = await this.#api(`POST /repos/${repository}/git/blobs`, {
        content: Buffer.from(updated, "utf8").toString("base64"),
        encoding: CONTENTS_ENCODING,
      });
      entries.push({ path, mode, type: "blob", sha: this.#parse(CreatedBlob, blob.data, `blob for ${path}`).sha });
    }

    const tree = await this.#api(`POST /repos/${repository}/git/trees`, {
      base_tree: parent.tree.sha,
      tree: entries,
    });
    const commit = await this.#api(`POST /repos/${repository}/git/commits`, {
      message: fixCommitMessage({ title: input.title, proposalId: input.proposalId, reviewedSha: commitSha }),
      tree: this.#parse(CreatedTree, tree.data, "created tree").sha,
      parents: [commitSha],
    });
    return this.#parse(GitCommit, commit.data, "created commit").sha;
  }

  /**
   * The git mode of `path` in `treeSha`, found by walking one tree level per path
   * segment. Deliberately not `?recursive=1`: that response is TRUNCATED on large
   * repositories, and a truncated listing would make a real path look missing.
   * A path that is absent (or is not a blob) at the reviewed revision throws —
   * the same fate as a hallucinated path.
   */
  async #blobMode(repository: string, treeSha: string, path: string): Promise<string> {
    const segments = path.split("/");
    let current = treeSha;
    for (const [index, segment] of segments.entries()) {
      const listed = await this.#api(`GET /repos/${repository}/git/trees/${current}`);
      const entry = this.#parse(GitTree, listed.data, `git tree ${current}`).tree.find((e) => e.path === segment);
      if (!entry) throw new Error(`github-app: path '${path}' does not exist at the reviewed revision`);
      const last = index === segments.length - 1;
      if (last) {
        if (entry.type !== "blob") throw new Error(`github-app: path '${path}' is a ${entry.type}, not a file`);
        return entry.mode;
      }
      if (entry.type !== "tree" || !entry.sha) throw new Error(`github-app: path '${path}' traverses a non-directory`);
      current = entry.sha;
    }
    throw new Error(`github-app: path '${path}' could not be resolved`);
  }

  /** A git commit object by sha. */
  async #commit(repository: string, sha: string): Promise<z.infer<typeof GitCommit>> {
    const fetched = await this.#api(`GET /repos/${repository}/git/commits/${sha}`);
    return this.#parse(GitCommit, fetched.data, `git commit ${sha}`);
  }

  #toPullResult(pull: z.infer<typeof PullSummary>): Omit<PullRequestResult, "created"> {
    return { number: pull.number, url: pull.html_url, headSha: pull.head.sha, draft: pull.draft ?? false };
  }

  // ── Work-item issues ────────────────────────────────────────────────────────

  /**
   * Idempotent on (repository, marker). GitHub issues carry no `external_id`, so
   * the marker embedded in the body IS the key:
   *
   *  0. `input.knownRef` — a reference the caller already persisted — short-circuits
   *     straight to the update. This is the common path (every re-dispatch, every
   *     body reconciliation) and skipping the lookup is what keeps publication from
   *     costing a walk of the repository's whole label-scoped issue history each
   *     time. It is an optimisation only: identity is still the marker, which is
   *     what step 1 falls back to;
   *  1. otherwise list this repository's Scruffy-labelled issues newest-first and
   *     look for the marker in a body. Deliberately NOT the search API:
   *     `GET /search/issues` is index-backed and lags a write by seconds to minutes,
   *     which is exactly the window a crash-resume lands in — it would report "no
   *     match" for an issue GitHub had already created and we would open a
   *     duplicate. The `/issues` list endpoint reads the primary store and is
   *     immediately consistent. The title is never consulted either: titles carry
   *     counts and line numbers that change between attempts;
   *  2. a match is UPDATED in place (title/body/labels refreshed, `created: false`)
   *     — this is what makes the crash-after-create retry recover instead of
   *     duplicate;
   *  3. no match creates the issue with the marker appended and the labels applied.
   *
   * The marker is appended here rather than trusted from the caller's body, so the
   * lookup key and the published text cannot drift apart. Labels are re-sent on
   * every update for the same reason: the lookup is label-scoped, so a human who
   * removed one would otherwise make the label part of the identity and the next
   * publication would open a second issue carrying the same marker.
   */
  async upsertIssue(input: IssueUpsertInput): Promise<IssueUpsertResult> {
    const body = withIssueMarker(input.body, input.marker);
    const existing =
      input.knownRef ?? (await this.#findIssueByMarker(input.repository, input.marker, input.labels));

    if (existing !== null) {
      const patched = await this.#api(`PATCH /repos/${input.repository}/issues/${existing.number}`, {
        title: input.title,
        body,
        labels: [...input.labels],
        // Only sent when the caller explicitly asked for a state. Omitting the key
        // leaves GitHub's current state untouched, which is what a body refresh of a
        // human-closed issue must do.
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.state === "closed" && input.stateReason !== undefined ? { state_reason: input.stateReason } : {}),
      });
      // Re-parse the PATCH response rather than reusing the listed row: the update
      // is the authoritative post-write view of the issue.
      const issue = this.#parse(IssueResponse, patched.data, "updated issue");
      return { ...toIssueRef(issue), created: false };
    }

    const created = await this.#api(`POST /repos/${input.repository}/issues`, {
      title: input.title,
      body,
      labels: [...input.labels],
    });
    return { ...toIssueRef(this.#parse(IssueResponse, created.data, "created issue")), created: true };
  }

  /**
   * Attach a child using GitHub's NATIVE sub-issue hierarchy
   * (`POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues`), which keys on
   * the child's database id rather than its number. Idempotent: an already-attached
   * child is detected by listing first, and a concurrent attach that loses the race
   * surfaces as a 422 which we resolve by re-listing.
   *
   * GitHub caps a parent at 100 sub-issues. Exceeding it is rejected, so the attach
   * fails, is retried, and dead-letters with the provider's reason against the
   * child's work item — visible on the parent body and the check. Loud and honest,
   * but it does mean a run surfacing more than 100 items cannot fully attach.
   */
  async linkChildIssue(input: IssueLinkInput): Promise<IssueLinkResult> {
    const childId = Number(input.child.id);
    if (!Number.isSafeInteger(childId) || childId <= 0) {
      // The native endpoint takes an integer database id. A non-numeric handle means
      // the stored reference came from a different provider or a bad parse; refuse
      // rather than POST something GitHub will misinterpret.
      throw new Error(`github-app: child issue id '${input.child.id}' is not a GitHub issue database id`);
    }

    if (await this.#hasSubIssue(input.repository, input.parent.number, childId)) {
      return { alreadyLinked: true };
    }

    try {
      await this.#api(`POST /repos/${input.repository}/issues/${input.parent.number}/sub_issues`, {
        sub_issue_id: childId,
      });
      return { alreadyLinked: false };
    } catch (err) {
      // 422 covers "already a sub-issue" and a lost concurrent-attach race. Re-list
      // to distinguish it from a genuine rejection (e.g. a cycle), which must throw.
      if (statusOf(err) !== 422) throw err;
      if (await this.#hasSubIssue(input.repository, input.parent.number, childId)) {
        return { alreadyLinked: true };
      }
      throw err;
    }
  }

  /**
   * The Scruffy-labelled issue carrying `marker`, or null. Walks pages newest-first
   * and stops at the first short page; exhausting `ISSUE_LOOKUP_MAX_PAGES` throws
   * rather than reporting a false "not found" that would open a duplicate.
   *
   * The walk is O(label-scoped history) in the not-found case, because `labels` is
   * an AND filter and `state=all` means closed issues never age out. Callers that
   * hold a durable reference pass `knownRef` and never reach here, so this runs on a
   * work item's FIRST publication and on crash-resume only. A repository that
   * accumulates more than `ISSUE_LOOKUP_MAX_PAGES` * 100 Scruffy issues of one kind
   * will start failing loudly here; that is the deliberate direction to fail in.
   */
  async #findIssueByMarker(repository: string, marker: string, labels: readonly string[]): Promise<IssueResponse | null> {
    for (let page = 1; page <= ISSUE_LOOKUP_MAX_PAGES; page += 1) {
      const listed = await this.#api(`GET /repos/${repository}/issues`, {
        state: "all",
        labels: labels.join(","),
        sort: "created",
        direction: "desc",
        per_page: ISSUE_PAGE_SIZE,
        page,
      });
      const issues = this.#parse(IssueList, listed.data, "issues list");
      // `/issues` returns pull requests too; a PR body is not a published work item.
      const match = issues.find((issue) => issue.pull_request === undefined && (issue.body ?? "").includes(marker));
      if (match) return match;
      if (issues.length < ISSUE_PAGE_SIZE) return null;
    }
    throw new Error(
      `github-app: marker lookup for ${marker} exceeded ${ISSUE_LOOKUP_MAX_PAGES} pages in ${repository} — ` +
        "refusing to create a possible duplicate issue",
    );
  }

  /**
   * Is the issue with database id `childId` already a native sub-issue of
   * `parentNumber`?
   *
   * Matched on `id`, not `number`, because sub-issues may live in ANOTHER
   * repository: a parent whose list contains `other/repo#11` would make a
   * number-based check claim our own `#11` was attached when it was not, and the
   * parent body would then report a child as attached that no one can find.
   */
  async #hasSubIssue(repository: string, parentNumber: number, childId: number): Promise<boolean> {
    for (let page = 1; page <= ISSUE_LOOKUP_MAX_PAGES; page += 1) {
      const listed = await this.#api(`GET /repos/${repository}/issues/${parentNumber}/sub_issues`, {
        per_page: ISSUE_PAGE_SIZE,
        page,
      });
      const subs = this.#parse(SubIssueList, listed.data, "sub-issues list");
      if (subs.some((sub) => sub.id === childId)) return true;
      if (subs.length < ISSUE_PAGE_SIZE) return false;
    }
    throw new Error(
      `github-app: sub-issue listing for #${parentNumber} exceeded ${ISSUE_LOOKUP_MAX_PAGES} pages in ${repository} — ` +
        "refusing to create a possible duplicate attachment",
    );
  }

  /** The PR for a head branch (ANY state — a closed fix PR is a human decision), or null. */
  async #findPullByHead(repository: string, head: string): Promise<Omit<PullRequestResult, "created"> | null> {
    const listed = await this.#api(`GET /repos/${repository}/pulls`, { head, state: "all", per_page: 1 });
    const pulls = this.#parse(PullsList, listed.data, "pulls list");
    return pulls.length > 0 ? this.#toPullResult(pulls[0]!) : null;
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

/** GitHub issue JSON -> the provider-neutral reference the domain stores. */
function toIssueRef(issue: IssueResponse): { number: number; id: string; url: string } {
  return { number: issue.number, id: String(issue.id), url: issue.html_url };
}

/** A numeric `status` off an unknown error (Octokit's RequestError carries one), or null. */
function statusOf(err: unknown): number | null {
  if (typeof err === "object" && err !== null && "status" in err && typeof (err as { status: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return null;
}

/**
 * Verify every supplied `expectedOriginal` against `content`. Pure; exported for
 * tests.
 *
 * This is the precondition the old writer did not have: it replaced whatever
 * occupied a line range, so a proposal computed against one revision could be
 * applied to content that had since changed — silently destroying the new text.
 * A mismatch here means the patch is stale or the preimage was fabricated;
 * either way the whole proposal is refused, not partially applied.
 *
 * Edits WITHOUT a preimage are not silently accepted as "verified" — they are
 * simply not preimage-anchored, and their safety comes from the commit being
 * parented on the reviewed sha whose content this function was handed.
 */
export function verifyPreimages(content: string, edits: readonly PullRequestEdit[], reviewedSha: string): void {
  const lines = content.split("\n");
  for (const edit of edits) {
    if (edit.expectedOriginal === undefined) continue;
    if (edit.startLine < 1 || edit.endLine > lines.length) {
      throw new Error(
        `preimage for ${edit.path} lines ${edit.startLine}-${edit.endLine} is out of range at ${reviewedSha} ` +
          `(file has ${lines.length} lines)`,
      );
    }
    const actual = lines.slice(edit.startLine - 1, edit.endLine).join("\n");
    if (actual !== edit.expectedOriginal) {
      throw new Error(
        `preimage mismatch for ${edit.path} lines ${edit.startLine}-${edit.endLine} at ${reviewedSha} — ` +
          "refusing to apply a stale or unanchored edit",
      );
    }
  }
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
