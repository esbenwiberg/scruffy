import { spawn } from "node:child_process";
import type { SubjectRevision } from "../../domain/evidence/types.js";
import type {
  ChangedFile,
  CheckRunInput,
  CheckRunResult,
  PullRequestInput,
  PullRequestResult,
  RevisionRange,
  ScmReader,
  ScmWriter,
} from "./port.js";

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

function defaultRunGh(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`gh ${args.join(" ")} exited ${code}: ${stderr.trim() || "no stderr"}`));
    });
    child.stdin.end(stdin ?? "");
  });
}

/** A GitHub file entry from a compare/commit response. `patch` is omitted for
 * binary, over-size, and pure-rename files — callers must default it to "". */
interface GhFile {
  filename: string;
  patch?: string;
}

function mapFiles(files: GhFile[]): ChangedFile[] {
  return files.map((f) => ({ path: f.filename, patch: f.patch ?? "" }));
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
      return this.getChangedFilesInRange({ repository: subject.repository, baseSha: base, headSha: subject.commitSha });
    }
    // No associated PR: fall back to the head commit's own file list. This is a
    // narrower change set than a full PR diff (truncated context), but well-defined.
    const raw = await this.#runGh(["api", `repos/${subject.repository}/commits/${subject.commitSha}`]);
    const files = this.#parseFiles(this.#parseJson(raw)?.files);
    return mapFiles(files);
  }

  async getChangedFilesInRange(range: RevisionRange): Promise<ChangedFile[]> {
    if (range.baseSha === null) {
      // First-ever review of a branch: no base to compare against. Use the head
      // commit's own change set (the port's documented contract for a null base).
      return this.getChangedFiles({ repository: range.repository, commitSha: range.headSha });
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

  /** The base sha of an OPEN PR whose head is `subject.commitSha`, or null if none. */
  async #associatedPrBase(subject: SubjectRevision): Promise<string | null> {
    const raw = await this.#runGh(["api", `repos/${subject.repository}/commits/${subject.commitSha}/pulls`]);
    const prs = this.#parseJson(raw);
    if (!Array.isArray(prs)) return null;
    const open = prs.find((p) => p?.state === "open") ?? prs[0];
    const base = open?.base?.sha;
    return typeof base === "string" && /^[0-9a-f]{40}$/.test(base) ? base : null;
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
    // context — re-posting simply supersedes. Report the status id; `created` is
    // always true (a status has no prior-existence signal like a check-run does).
    const id = String(this.#parseJson(raw)?.id ?? `${repository}@${commitSha}#${input.name}`);
    return { id, created: true };
  }

  async openPullRequest(_input: PullRequestInput): Promise<PullRequestResult> {
    // Fix-PR writes are a later slice. Fail LOUDLY so a stray pull_request effect is
    // left pending by the dispatcher, never silently dropped.
    throw new Error("openPullRequest is not enabled in the gh-cli adapter (poison posts a commit status only)");
  }

  // ── Parsing helpers ──────────────────────────────────────────────────────────

  #parseJson(raw: string): any {
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
}

/** Poison/gate conclusion -> commit-status state. Statuses have no `neutral`; an
 * abstention (indeterminate -> neutral) maps to `pending` (the non-committal state). */
export function conclusionToState(conclusion: CheckRunInput["conclusion"]): "success" | "failure" | "pending" {
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
