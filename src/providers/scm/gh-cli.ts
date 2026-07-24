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

/** Hard wall-clock cap on a `gh` invocation. A wedged network must fail the read
 * (→ the gate abstains) rather than hang the blocking poison path forever. */
const GH_TIMEOUT_MS = 60_000;

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
        else reject(new Error(`gh ${args.join(" ")} exited ${code}: ${stderr.trim() || "no stderr"}`));
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
      return this.getChangedFilesInRange({ repository: subject.repository, baseSha: base, headSha: subject.commitSha });
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
    const files = this.#parseFiles(this.#parseJson(raw)?.files);
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
    const raw = await this.#runGh(["api", `repos/${subject.repository}/commits/${subject.commitSha}/pulls`]);
    const prs = this.#parseJson(raw);
    if (!Array.isArray(prs)) return null;
    const open = prs.find((p) => p?.state === "open");
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
    // context — re-posting simply supersedes, satisfying the port's no-duplicate
    // invariant. Two caveats vs. the port's canonical contract, both documented on
    // ScmWriter/CheckRunResult and NOT relied on by any effects code:
    //   - idempotency is keyed on (subject, name=context), NOT externalId — a single
    //     POST to /statuses/{sha} exposes no way to key on externalId;
    //   - `created` is always true — a status has no create-vs-supersede signal like
    //     a check-run does, and probing for one would need an extra GET on this
    //     blocking write path (plus a TOCTOU race) for a value callers must treat as
    //     advisory anyway. It is left true; effects MUST NOT gate on it.
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
