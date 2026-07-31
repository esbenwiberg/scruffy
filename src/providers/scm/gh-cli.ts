import { spawn } from "node:child_process";
import type { SubjectRevision } from "../../domain/evidence/types.js";
import type {
  CandidateCiEvidence,
  CandidateCiRecord,
  ChangedFile,
  CheckRunInput,
  CheckRunResult,
  FileContentResult,
  IssueLinkInput,
  IssueLinkResult,
  IssueUpsertInput,
  IssueUpsertResult,
  PullRequestInput,
  PullRequestResult,
  RepositoryOpenWorkObservation,
  RevisionRange,
  ScmReader,
  ScmWriter,
} from "./port.js";
import { normalizeCheckRunConclusion, normalizeCommitStatusState } from "./candidate-ci.js";

/**
 * GitHub SCM adapter that shells out to the authenticated `gh` CLI — reusing the
 * developer's existing `gh` session rather than a token in config (mirrors the
 * claude-cli model backend, honours the no-secrets rule).
 *
 * WRITE SURFACE — commit statuses, not check-runs. Creating check-runs requires a
 * GitHub App (`checks:write`); a user token (which is what `gh` holds) gets 403.
 * Commit statuses only need push access, which `gh` has. So a `check_run` effect
 * is rendered as a commit status: conclusion -> state, name -> context,
 * title -> description. The status is SHADOW by construction — a status is only
 * blocking if a repo admin marks its context a *required* check, so scruffy posts
 * the honest state and never blocks a merge on its own. The richer check-run object
 * (title + summary + annotations) is a later GitHub-App slice.
 *
 * ERROR DISCIPLINE (load-bearing): every read throws on any `gh`/API failure and
 * never returns []. Poison is a blocking gate; an empty change set on an infra
 * fault would yield zero findings -> `allow` -> a false green. Empty is reserved
 * for a genuinely empty diff. The poison service's own catch turns a throw into
 * `indeterminate` (a neutral/pending status), which is the safe outcome.
 */

/** Runs `gh <args>` with optional stdin, resolves stdout, REJECTS on non-zero exit. */
export type RunGh = (args: string[], stdin?: string) => Promise<string>;

/** GitHub's compare/commit endpoints hard-cap the file list at 300. At the cap we
 * cannot tell a complete diff from a truncated one, so we refuse to scan partially. */
const COMPARE_FILE_CAP = 300;

/** GitHub commit-status description max length. */
const STATUS_DESC_MAX = 140;

/** Anchoring a multi-megabyte file is never a mechanical, low-ambiguity edit;
 * refuse rather than read it in and silently balloon memory/patch size. */
const MAX_CONTENT_BYTES = 1_000_000;

/** Hard wall-clock cap on a `gh` invocation. A wedged network must fail the read
 * (→ the gate abstains) rather than hang the blocking poison path forever. */
const GH_TIMEOUT_MS = 60_000;

/** Context is useful, but must never turn a report into an unbounded backlog crawl. */
const OPEN_WORK_PER_PAGE = 100;
const OPEN_WORK_MAX_PAGES = 5;

function defaultRunGh(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    // Decode as UTF-8 per chunk so a multibyte character split across a chunk
    // boundary is not corrupted into U+FFFD (would corrupt patch/snippet text).
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(() => reject(new Error(`gh ${args.join(" ")} timed out after ${GH_TIMEOUT_MS}ms`)));
    }, GH_TIMEOUT_MS);

    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (err) => settle(() => reject(err)));
    // If the child dies before consuming stdin, the write raises EPIPE as an
    // 'error' on the stdin stream; without a listener Node throws and kills the
    // whole process, bypassing the gate's abstain-on-failure discipline.
    child.stdin.on("error", (err) => settle(() => reject(err)));
    child.on("close", (code) =>
      settle(() => {
        if (code === 0) resolve(stdout);
        else
          reject(new Error(`gh ${args.join(" ")} exited ${code}: ${stderr.trim() || "no stderr"}`));
      }),
    );
    child.stdin.end(stdin ?? "");
  });
}

/** A GitHub file entry from a compare/commit response. `patch` is omitted for
 * binary and pure-rename files (which have no added lines) AND for text files
 * whose diff GitHub dropped for being too large. `additions` distinguishes them:
 * a file with added lines but no patch is a truncated read we must not scan. */
interface GhFile {
  filename: string;
  patch?: string;
  additions?: number;
}

function mapFiles(files: GhFile[]): ChangedFile[] {
  return files.map((f) => {
    if (f.patch === undefined && (f.additions ?? 0) > 0) {
      // Added lines exist but the patch is unavailable (too large to diff). Scanning
      // this as "no added lines" would let a secret in an oversized file pass as
      // clean. Throw so the gate abstains instead of false-greening.
      throw new Error(
        `gh: ${f.filename} has ${f.additions} added lines but no patch (too large to diff) — cannot scan completely`,
      );
    }
    return { path: f.filename, patch: f.patch ?? "" };
  });
}

export interface GhCliScmOptions {
  /** Injected for tests; defaults to the real `gh` process. */
  runGh?: RunGh;
  /** Optional URL to attach to a posted status (e.g. a run/dashboard link). */
  targetUrl?: string;
}

export class GhCliScm implements ScmReader, ScmWriter {
  readonly #runGh: RunGh;
  readonly #targetUrl: string | undefined;

  constructor(options: GhCliScmOptions = {}) {
    this.#runGh = options.runGh ?? defaultRunGh;
    this.#targetUrl = options.targetUrl;
  }

  // ── Reader ─────────────────────────────────────────────────────────────────

  async getChangedFiles(subject: SubjectRevision): Promise<ChangedFile[]> {
    const base = await this.#associatedPrBase(subject);
    if (base !== null) {
      return this.getChangedFilesInRange({
        repository: subject.repository,
        baseSha: base,
        headSha: subject.commitSha,
      });
    }
    // No associated PR: fall back to the head commit's own file list. This is a
    // narrower change set than a full PR diff (truncated context), but well-defined.
    return this.#commitOwnFiles(subject.repository, subject.commitSha);
  }

  /** The commit's own change set — the files that commit introduces — with no PR
   * resolution. Both the no-PR reader fallback and the null-base range use this so
   * the null-base contract ("the head candidate's own change set") holds regardless
   * of whether an open PR happens to point at the head commit. */
  async #commitOwnFiles(repository: string, commitSha: string): Promise<ChangedFile[]> {
    const raw = await this.#runGh(["api", `repos/${repository}/commits/${commitSha}`]);
    const files = this.#parseFiles((this.#parseJson(raw) as { files?: unknown } | null)?.files);
    if (files.length >= COMPARE_FILE_CAP) {
      // The commit endpoint also caps its files array at 300; at the cap we cannot
      // distinguish complete from truncated, so we refuse to scan a partial diff
      // (same discipline as the compare path).
      throw new Error(
        `gh commit ${commitSha}: ${files.length} files hits GitHub's ${COMPARE_FILE_CAP}-file cap — diff too large to scan completely`,
      );
    }
    return mapFiles(files);
  }

  async getChangedFilesInRange(range: RevisionRange): Promise<ChangedFile[]> {
    if (range.baseSha === null) {
      // First-ever review of a branch: no base to compare against. Use the head
      // commit's own change set (the port's documented contract for a null base).
      // Call #commitOwnFiles directly, NOT getChangedFiles: the latter resolves an
      // associated open PR and would silently widen the scan to the PR's base...head
      // diff, breaking the contract whenever a PR happens to point at the head.
      return this.#commitOwnFiles(range.repository, range.headSha);
    }

    // --slurp wraps every page in an array so all files are collected even when
    // GitHub paginates the compare response.
    const raw = await this.#runGh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${range.repository}/compare/${range.baseSha}...${range.headSha}`,
    ]);
    const pages = this.#parseJson(raw);
    if (!Array.isArray(pages)) throw new Error("gh compare: expected a slurped array of pages");
    const files = pages.flatMap((p) => this.#parseFiles(p?.files));

    if (files.length >= COMPARE_FILE_CAP) {
      // GitHub caps compare at 300 files; at the cap we cannot trust completeness.
      // Throw rather than scan a partial diff and report a blocking gate as clean.
      throw new Error(
        `gh compare ${range.baseSha}...${range.headSha}: ${files.length} files hits GitHub's ${COMPARE_FILE_CAP}-file cap — diff too large to scan completely`,
      );
    }
    return mapFiles(files);
  }

  /** The base sha of an OPEN PR whose head is `subject.commitSha`, or null if none.
   * Only open PRs count: falling back to a closed PR's base would compute the diff
   * over a stale, irrelevant range. No open PR -> null -> scan the commit itself. */
  async #associatedPrBase(subject: SubjectRevision): Promise<string | null> {
    const raw = await this.#runGh([
      "api",
      `repos/${subject.repository}/commits/${subject.commitSha}/pulls`,
    ]);
    const prs = this.#parseJson(raw);
    if (!Array.isArray(prs)) return null;
    const open = prs.find((p) => p?.state === "open");
    const base = open?.base?.sha;
    return typeof base === "string" && /^[0-9a-f]{40}$/.test(base) ? base : null;
  }

  /**
   * Immutable full-file content at `subject.commitSha`, via `gh api contents`.
   * Reports `complete: false` with a stable reason for anything that is not a
   * clean, safely anchorable text read — never throws for an ordinary
   * "cannot serve this read" case, so one path's gap does not abort the
   * caller's whole remediation attempt.
   */
  async getFileContent(subject: SubjectRevision, path: string): Promise<FileContentResult> {
    try {
      const raw = await this.#runGh([
        "api",
        `repos/${subject.repository}/contents/${path}`,
        "-f",
        `ref=${subject.commitSha}`,
      ]);
      const data = this.#parseJson(raw) as
        { type?: unknown; encoding?: unknown; content?: unknown } | unknown[] | null;
      if (Array.isArray(data)) {
        return { complete: false, path, reason: "not_found", detail: "path is a directory" };
      }
      if (data === null || typeof data !== "object" || typeof data.type !== "string") {
        throw new Error("gh contents: unexpected response shape");
      }
      if (data.type !== "file") {
        return { complete: false, path, reason: "not_found", detail: `path is a ${data.type}` };
      }
      if (data.encoding !== "base64" || typeof data.content !== "string") {
        return {
          complete: false,
          path,
          reason: "oversized",
          detail: "content not inline (file too large for the contents API)",
        };
      }
      const buffer = Buffer.from(data.content, "base64");
      if (buffer.byteLength > MAX_CONTENT_BYTES) {
        return { complete: false, path, reason: "oversized" };
      }
      if (isBinary(buffer)) {
        return { complete: false, path, reason: "binary" };
      }
      return { complete: true, path, content: buffer.toString("utf8") };
    } catch (err) {
      if (isGhNotFound(err)) return { complete: false, path, reason: "not_found" };
      return {
        complete: false,
        path,
        reason: "provider_error",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Normalized candidate-CI evidence for the EXACT candidate SHA. Reads BOTH GitHub
   * check runs and commit statuses for the commit and normalizes each into one
   * record set. Every `gh` failure REJECTS (never []): a fault must not read as
   * "no required checks" and false-green the release lane. `per_page=100` keeps the
   * common few-context case single-page; a context beyond that reads as missing
   * (incomplete -> sign-off), which errs safe rather than false-clean.
   */
  async getCandidateCi(subject: SubjectRevision): Promise<CandidateCiEvidence> {
    const { repository, commitSha } = subject;
    const records: CandidateCiRecord[] = [];

    const checkRunsRaw = await this.#runGh([
      "api",
      `repos/${repository}/commits/${commitSha}/check-runs?per_page=100`,
    ]);
    const checkRuns = this.#parseCheckRuns(
      (this.#parseJson(checkRunsRaw) as { check_runs?: unknown } | null)?.check_runs,
    );
    for (const run of checkRuns) {
      records.push({
        context: run.name,
        state: normalizeCheckRunConclusion(run.status, run.conclusion ?? null),
        // A check run carries its own head_sha; keep it so wrong-SHA evidence is
        // detectable downstream rather than assumed to match the candidate.
        sha: typeof run.head_sha === "string" ? run.head_sha : commitSha,
        source: "check-run",
        ...((run.completed_at ?? run.started_at)
          ? { updatedAt: (run.completed_at ?? run.started_at)! }
          : {}),
      });
    }

    const statusesRaw = await this.#runGh([
      "api",
      `repos/${repository}/commits/${commitSha}/statuses?per_page=100`,
    ]);
    const statuses = this.#parseStatuses(this.#parseJson(statusesRaw));
    for (const status of statuses) {
      // The statuses endpoint is per-sha, so each record binds to the requested candidate.
      records.push({
        context: status.context,
        state: normalizeCommitStatusState(status.state),
        sha: commitSha,
        source: "commit-status",
        ...(status.updated_at ? { updatedAt: status.updated_at } : {}),
      });
    }

    return { sha: commitSha, records };
  }

  /**
   * Context-only release snapshot: exact-label open bugs plus every open PR.
   * Reads at most 500 of each; reaching the bound returns the observed records
   * with an explicit gap rather than walking an unbounded repository backlog.
   */
  async getOpenReleaseWork(repository: string): Promise<RepositoryOpenWorkObservation> {
    const gaps: string[] = [];
    const bugIssues: RepositoryOpenWorkObservation["bugIssues"] = [];
    const openPullRequests: RepositoryOpenWorkObservation["openPullRequests"] = [];

    for (let page = 1; page <= OPEN_WORK_MAX_PAGES; page += 1) {
      const raw = await this.#runGh([
        "api",
        `repos/${repository}/issues?state=open&labels=bug&per_page=${OPEN_WORK_PER_PAGE}&page=${page}`,
      ]);
      const issues = this.#parseOpenIssues(this.#parseJson(raw));
      for (const issue of issues) {
        // GitHub's issues endpoint also returns pull requests. PRs belong in the
        // complete open-PR listing below, never masquerading as bug issues.
        if (issue.pull_request !== undefined) continue;
        bugIssues.push({
          number: issue.number,
          url: issue.html_url,
          title: issue.title,
          labels: issue.labels.map((label) => (typeof label === "string" ? label : label.name)),
          ...(issue.updated_at ? { updatedAt: issue.updated_at } : {}),
        });
      }
      if (issues.length < OPEN_WORK_PER_PAGE) break;
      if (page === OPEN_WORK_MAX_PAGES) {
        gaps.push(
          `open bug issue listing reached the ${OPEN_WORK_MAX_PAGES * OPEN_WORK_PER_PAGE}-item bound`,
        );
      }
    }

    for (let page = 1; page <= OPEN_WORK_MAX_PAGES; page += 1) {
      const raw = await this.#runGh([
        "api",
        `repos/${repository}/pulls?state=open&per_page=${OPEN_WORK_PER_PAGE}&page=${page}`,
      ]);
      const pulls = this.#parseOpenPullRequests(this.#parseJson(raw));
      for (const pr of pulls) {
        openPullRequests.push({
          number: pr.number,
          url: pr.html_url,
          title: pr.title,
          draft: pr.draft,
          headSha: pr.head.sha,
          headBranch: pr.head.ref,
          baseBranch: pr.base.ref,
          ...(pr.user?.login ? { author: pr.user.login } : {}),
          ...(pr.updated_at ? { updatedAt: pr.updated_at } : {}),
        });
      }
      if (pulls.length < OPEN_WORK_PER_PAGE) break;
      if (page === OPEN_WORK_MAX_PAGES) {
        gaps.push(
          `open pull request listing reached the ${OPEN_WORK_MAX_PAGES * OPEN_WORK_PER_PAGE}-item bound`,
        );
      }
    }

    bugIssues.sort((a, b) => a.number - b.number);
    openPullRequests.sort((a, b) => a.number - b.number);
    return { complete: gaps.length === 0, bugIssues, openPullRequests, gaps };
  }

  // ── Writer (check-run effect -> commit status) ───────────────────────────────

  async upsertCheckRun(input: CheckRunInput): Promise<CheckRunResult> {
    const { repository, commitSha } = input.subject;
    const state = conclusionToState(input.conclusion);
    const description = input.title.slice(0, STATUS_DESC_MAX);
    const args = [
      "api",
      "-X",
      "POST",
      `repos/${repository}/statuses/${commitSha}`,
      "-f",
      `state=${state}`,
      "-f",
      `context=${input.name}`,
      "-f",
      `description=${description}`,
      ...(this.#targetUrl ? ["-f", `target_url=${this.#targetUrl}`] : []),
    ];
    const raw = await this.#runGh(args);
    // Statuses are "latest per (sha, context) wins", so every post is idempotent by
    // context — re-posting simply supersedes, satisfying the port's no-duplicate
    // invariant. Two caveats vs. the port's canonical contract, both documented on
    // ScmWriter/CheckRunResult and NOT relied on by any effects code:
    //   - idempotency is keyed on (subject, name=context), NOT externalId — a single
    //     POST to /statuses/{sha} exposes no way to key on externalId;
    //   - `created` is always true — a status has no create-vs-supersede signal like
    //     a check-run does, and probing for one would need an extra GET on this
    //     blocking write path (plus a TOCTOU race) for a value callers must treat as
    //     advisory anyway. It is left true; effects MUST NOT gate on it.
    const id = String(
      (this.#parseJson(raw) as { id?: unknown } | null)?.id ??
        `${repository}@${commitSha}#${input.name}`,
    );
    return { id, created: true };
  }

  async openPullRequest(_input: PullRequestInput): Promise<PullRequestResult> {
    // Fix-PR writes are a later slice. Fail LOUDLY so a stray pull_request effect is
    // left pending by the dispatcher, never silently dropped.
    throw new Error(
      "openPullRequest is not enabled in the gh-cli adapter (poison posts a commit status only)",
    );
  }

  // ── Writer (work-item issues) ────────────────────────────────────────────────
  //
  // NOT IMPLEMENTED, ON PURPOSE. This is the development adapter: it reuses a
  // developer's `gh` session, which is a different (broader) credential from the
  // App installation ADR-0001 reserves for effects, and it has no way to prove a
  // marker lookup read the primary store rather than a lagging index. Publishing
  // real, human-visible issues from a developer's own identity — or worse,
  // duplicating a repository's nightly parent issue because the lookup missed — is
  // not a tradeoff this adapter gets to make.
  //
  // Both methods THROW so a stray issue effect is retried and then dead-lettered
  // with an honest reason. The one thing they must never do is return a fabricated
  // reference: that would let the dispatcher record a publication that does not
  // exist and mark the graph published. Set SCRUFFY_SCM_WRITER=github-app to
  // publish issues.

  async upsertIssue(_input: IssueUpsertInput): Promise<IssueUpsertResult> {
    throw new Error(
      "upsertIssue is not enabled in the gh-cli adapter — nightly issue publication requires the GitHub App writer " +
        "(set SCRUFFY_SCM_WRITER=github-app)",
    );
  }

  async linkChildIssue(_input: IssueLinkInput): Promise<IssueLinkResult> {
    throw new Error(
      "linkChildIssue is not enabled in the gh-cli adapter — native sub-issue attachment requires the GitHub App writer " +
        "(set SCRUFFY_SCM_WRITER=github-app)",
    );
  }

  // ── Parsing helpers ──────────────────────────────────────────────────────────

  #parseJson(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("gh returned non-JSON output");
    }
  }

  #parseFiles(files: unknown): GhFile[] {
    if (files === undefined || files === null) return [];
    if (!Array.isArray(files)) throw new Error("gh response: `files` is not an array");
    return files as GhFile[];
  }

  #parseCheckRuns(runs: unknown): GhCheckRun[] {
    if (runs === undefined || runs === null) return [];
    if (!Array.isArray(runs)) throw new Error("gh response: `check_runs` is not an array");
    for (const run of runs) {
      if (typeof run?.name !== "string" || typeof run?.status !== "string") {
        throw new Error("gh response: a check run is missing `name`/`status`");
      }
    }
    return runs as GhCheckRun[];
  }

  #parseStatuses(statuses: unknown): GhStatus[] {
    if (statuses === undefined || statuses === null) return [];
    if (!Array.isArray(statuses)) throw new Error("gh response: `statuses` is not an array");
    for (const status of statuses) {
      if (typeof status?.context !== "string" || typeof status?.state !== "string") {
        throw new Error("gh response: a commit status is missing `context`/`state`");
      }
    }
    return statuses as GhStatus[];
  }

  #parseOpenIssues(value: unknown): GhOpenIssue[] {
    if (!Array.isArray(value)) throw new Error("gh response: open bug issues are not an array");
    for (const issue of value) {
      if (
        typeof issue?.number !== "number" ||
        typeof issue?.html_url !== "string" ||
        typeof issue?.title !== "string" ||
        !Array.isArray(issue?.labels) ||
        issue.labels.some(
          (label: unknown) =>
            typeof label !== "string" &&
            (typeof label !== "object" ||
              label === null ||
              typeof (label as { name?: unknown }).name !== "string"),
        )
      ) {
        throw new Error("gh response: an open bug issue has an unexpected shape");
      }
    }
    return value as GhOpenIssue[];
  }

  #parseOpenPullRequests(value: unknown): GhOpenPullRequest[] {
    if (!Array.isArray(value)) throw new Error("gh response: open pull requests are not an array");
    for (const pr of value) {
      if (
        typeof pr?.number !== "number" ||
        typeof pr?.html_url !== "string" ||
        typeof pr?.title !== "string" ||
        typeof pr?.draft !== "boolean" ||
        typeof pr?.head?.sha !== "string" ||
        typeof pr?.head?.ref !== "string" ||
        typeof pr?.base?.ref !== "string"
      ) {
        throw new Error("gh response: an open pull request has an unexpected shape");
      }
    }
    return value as GhOpenPullRequest[];
  }
}

/** A GitHub check-run entry (candidate-CI read). Only the fields we normalize. */
interface GhCheckRun {
  name: string;
  status: string;
  conclusion?: string | null;
  head_sha?: string;
  started_at?: string | null;
  completed_at?: string | null;
}

/** A GitHub commit-status entry (candidate-CI read). */
interface GhStatus {
  context: string;
  state: string;
  updated_at?: string;
}

interface GhOpenIssue {
  number: number;
  html_url: string;
  title: string;
  labels: (string | { name: string })[];
  updated_at?: string;
  pull_request?: unknown;
}

interface GhOpenPullRequest {
  number: number;
  html_url: string;
  title: string;
  draft: boolean;
  head: { sha: string; ref: string };
  base: { ref: string };
  user?: { login?: string } | null;
  updated_at?: string;
}

/** True when a `gh api` rejection is GitHub's 404, as reported in `gh`'s stderr text
 * (the CLI gives no structured status code, only "gh: Not Found (HTTP 404)"). */
function isGhNotFound(err: unknown): boolean {
  return err instanceof Error && /HTTP 404|Not Found/i.test(err.message);
}

/** Heuristic binary sniff: a NUL byte in the first few KB never occurs in valid
 * UTF-8 text, which is the same signal `git diff`/most editors use. */
function isBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, Math.min(buffer.length, 8192));
  return probe.includes(0);
}

/** Poison/gate conclusion -> commit-status state. Statuses have no `neutral`; an
 * abstention (indeterminate -> neutral) maps to `pending` (the non-committal state). */
export function conclusionToState(
  conclusion: CheckRunInput["conclusion"],
): "success" | "failure" | "pending" {
  switch (conclusion) {
    case "success":
      return "success";
    case "failure":
      return "failure";
    case "neutral":
      return "pending";
    default: {
      const _exhaustive: never = conclusion;
      return _exhaustive;
    }
  }
}
