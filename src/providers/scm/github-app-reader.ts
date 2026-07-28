import { z } from "zod";
import type { SubjectRevision } from "../../domain/evidence/types.js";
import type { CandidateCiEvidence, CandidateCiRecord, ChangedFile, RevisionRange, ScmReader } from "./port.js";
import type { GhApi } from "./github-app.js";
import { normalizeCheckRunConclusion, normalizeCommitStatusState } from "./candidate-ci.js";

/**
 * GitHub App-backed READER — the App-authenticated counterpart to the gh-cli
 * reader. ADR-0001 wants reads and writes on separate credentials; where the
 * gh-cli adapter reuses a developer's user session, this reads through the same
 * App installation transport the writer uses (`GhApi`), so a hosted deployment
 * never depends on a human's `gh` login. The App needs `contents` (compare +
 * commit files) and `pull_requests` (the associated-PR lookup) read access —
 * both implied by the writer's `contents:write` / `pull_requests:write`.
 *
 * ERROR DISCIPLINE (load-bearing, identical to the gh-cli reader): every read
 * throws on any API failure and NEVER returns []. Poison is a blocking gate; an
 * empty change set on an infra fault would yield zero findings -> `allow` -> a
 * false green. Empty is reserved for a genuinely empty diff. The gate's own catch
 * turns a throw into `indeterminate` (abstain), the safe outcome. The truncation
 * discipline is the same too: a file with added lines but no patch (too large to
 * diff) and a diff at GitHub's 300-file cap both throw rather than scan partially.
 */

/** GitHub's compare/commit endpoints hard-cap the file list at 300. At the cap we
 * cannot tell a complete diff from a truncated one, so we refuse to scan partially. */
const COMPARE_FILE_CAP = 300;

/** Files-per-page for the paginated compare read. GitHub's max is 100. */
const PER_PAGE = 100;

/** Hard bound on compare pages. 300-file cap / 100-per-page = 3 real pages; the
 * extra headroom tolerates a short final page without ever looping unbounded. */
const MAX_PAGES = 8;

// ── Response schemas (external boundary — parse, don't trust) ─────────────────

const GhFileSchema = z.object({
  filename: z.string(),
  patch: z.string().optional(),
  additions: z.number().optional(),
});
type GhFile = z.infer<typeof GhFileSchema>;

const FilesResponse = z.object({ files: z.array(GhFileSchema).optional() });

const CommitPulls = z.array(
  z.object({
    state: z.string(),
    base: z.object({ sha: z.string() }),
  }),
);

const CheckRunsCi = z.object({
  check_runs: z
    .array(
      z.object({
        name: z.string(),
        status: z.string(),
        conclusion: z.string().nullable().optional(),
        head_sha: z.string().optional(),
        started_at: z.string().nullable().optional(),
        completed_at: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

const CommitStatusesCi = z.array(
  z.object({
    context: z.string(),
    state: z.string(),
    updated_at: z.string().optional(),
  }),
);

export interface GithubAppScmReaderOptions {
  api: GhApi;
}

export class GithubAppScmReader implements ScmReader {
  readonly #api: GhApi;

  constructor(options: GithubAppScmReaderOptions) {
    this.#api = options.api;
  }

  async getChangedFiles(subject: SubjectRevision): Promise<ChangedFile[]> {
    const base = await this.#associatedPrBase(subject);
    if (base !== null) {
      return this.getChangedFilesInRange({ repository: subject.repository, baseSha: base, headSha: subject.commitSha });
    }
    // No associated open PR: fall back to the head commit's own file list — a
    // narrower change set than a full PR diff, but well-defined.
    return this.#commitOwnFiles(subject.repository, subject.commitSha);
  }

  async getChangedFilesInRange(range: RevisionRange): Promise<ChangedFile[]> {
    if (range.baseSha === null) {
      // First-ever review of a branch: no base to compare against. Use the head
      // commit's own change set (the port's documented null-base contract). Call
      // #commitOwnFiles directly, NOT getChangedFiles, so an open PR that happens
      // to point at the head cannot silently widen the scan to its base...head diff.
      return this.#commitOwnFiles(range.repository, range.headSha);
    }
    return this.#compareFiles(range.repository, range.baseSha, range.headSha);
  }

  /** The commit's own change set — the files that commit introduces — with no PR
   * resolution, mirroring the gh-cli reader so the null-base contract holds. */
  async #commitOwnFiles(repository: string, commitSha: string): Promise<ChangedFile[]> {
    const res = await this.#api(`GET /repos/${repository}/commits/${commitSha}`, { per_page: PER_PAGE });
    const files = this.#parse(FilesResponse, res.data, `commit ${commitSha}`).files ?? [];
    if (files.length >= COMPARE_FILE_CAP) {
      throw new Error(
        `github-app: commit ${commitSha} has ${files.length} files at GitHub's ${COMPARE_FILE_CAP}-file cap — diff too large to scan completely`,
      );
    }
    return mapFiles(files);
  }

  /**
   * All changed files across (base, head]. GitHub paginates the compare files and
   * caps them at 300. We page by filename-deduped accumulation: stop when a page
   * adds no new files (handles both real pagination AND the endpoint returning the
   * same capped set every page), and throw at the cap rather than scan a partial
   * diff as clean.
   */
  async #compareFiles(repository: string, baseSha: string, headSha: string): Promise<ChangedFile[]> {
    const byName = new Map<string, GhFile>();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const res = await this.#api(`GET /repos/${repository}/compare/${baseSha}...${headSha}`, { per_page: PER_PAGE, page });
      const files = this.#parse(FilesResponse, res.data, `compare ${baseSha}...${headSha}`).files ?? [];

      let added = 0;
      for (const f of files) {
        if (!byName.has(f.filename)) {
          byName.set(f.filename, f);
          added += 1;
        }
      }
      if (byName.size >= COMPARE_FILE_CAP) {
        throw new Error(
          `github-app: compare ${baseSha}...${headSha} hits GitHub's ${COMPARE_FILE_CAP}-file cap — diff too large to scan completely`,
        );
      }
      // A short page or a page that introduced nothing new means we have them all.
      if (files.length < PER_PAGE || added === 0) break;
    }
    return mapFiles([...byName.values()]);
  }

  /** Base sha of an OPEN PR whose head is `subject.commitSha`, or null if none.
   * Only open PRs count: a closed PR's base would compute the diff over a stale,
   * irrelevant range. No open PR -> null -> scan the commit itself. */
  async #associatedPrBase(subject: SubjectRevision): Promise<string | null> {
    const res = await this.#api(`GET /repos/${subject.repository}/commits/${subject.commitSha}/pulls`);
    const pulls = this.#parse(CommitPulls, res.data, "commit pulls");
    const open = pulls.find((p) => p.state === "open");
    if (!open) return null;
    return /^[0-9a-f]{40}$/.test(open.base.sha) ? open.base.sha : null;
  }

  /**
   * Normalized candidate-CI evidence for the EXACT candidate SHA — the App-auth
   * counterpart to the gh-cli reader. Reads both check runs and commit statuses
   * and normalizes them identically. Every API failure throws (the `#api` transport
   * rejects on non-2xx) and every unexpected shape throws (`#parse`); an empty
   * successful list is reserved for a genuinely CI-less candidate, so a fault can
   * never masquerade as "no required checks".
   */
  async getCandidateCi(subject: SubjectRevision): Promise<CandidateCiEvidence> {
    const { repository, commitSha } = subject;
    const records: CandidateCiRecord[] = [];

    const checkRunsRes = await this.#api(`GET /repos/${repository}/commits/${commitSha}/check-runs`, { per_page: PER_PAGE });
    const checkRuns = this.#parse(CheckRunsCi, checkRunsRes.data, `check-runs for ${commitSha}`).check_runs ?? [];
    for (const run of checkRuns) {
      records.push({
        context: run.name,
        state: normalizeCheckRunConclusion(run.status, run.conclusion ?? null),
        sha: run.head_sha ?? commitSha,
        source: "check-run",
        ...(run.completed_at ?? run.started_at ? { updatedAt: (run.completed_at ?? run.started_at)! } : {}),
      });
    }

    const statusesRes = await this.#api(`GET /repos/${repository}/commits/${commitSha}/statuses`, { per_page: PER_PAGE });
    const statuses = this.#parse(CommitStatusesCi, statusesRes.data, `statuses for ${commitSha}`);
    for (const status of statuses) {
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

  #parse<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new Error(`github-app: unexpected ${what} response shape: ${parsed.error.message}`);
    return parsed.data;
  }
}

/** Map GitHub file entries to ChangedFile, refusing an incomplete diff. A file
 * with added lines but no patch is oversized-and-dropped by GitHub: scanning it
 * as "no added lines" would let a secret in a huge file pass as clean, so throw. */
function mapFiles(files: GhFile[]): ChangedFile[] {
  return files.map((f) => {
    if (f.patch === undefined && (f.additions ?? 0) > 0) {
      throw new Error(
        `github-app: ${f.filename} has ${f.additions} added lines but no patch (too large to diff) — cannot scan completely`,
      );
    }
    return { path: f.filename, patch: f.patch ?? "" };
  });
}
