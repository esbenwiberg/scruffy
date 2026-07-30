import { z } from "zod";
import type { SubjectRevision } from "../../domain/evidence/types.js";
import type {
  ChangedFile,
  FileContentResult,
  InstalledRepository,
  RevisionRange,
  ScmInstallationReader,
  ScmReader,
} from "./port.js";
import type { GhApi } from "./github-app.js";

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

const ContentsResponse = z.object({
  type: z.string(),
  encoding: z.string().optional(),
  content: z.string().optional(),
});

/**
 * `GET /installation/repositories`. `total_count` is the endpoint's own claim about
 * how many repositories the installation has, and we CHECK the accumulated list
 * against it: that is the only available proof that pagination read everything
 * rather than stopping early on a truncated page.
 */
const InstallationRepositories = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: z.array(
    z.object({
      id: z.number().int(),
      full_name: z.string().min(1),
      default_branch: z.string().min(1),
      archived: z.boolean().optional(),
      disabled: z.boolean().optional(),
    }),
  ),
});

const BranchResponse = z.object({ commit: z.object({ sha: z.string().min(1) }) });

/**
 * Hard bound on installation-listing pages. The accepted deployment addresses one
 * App installation with fewer than 20 repositories; 100-per-page × 20 pages is two
 * orders of magnitude of headroom, and hitting it means something is wrong (a
 * non-advancing cursor) rather than that the installation is genuinely that large —
 * which is why the cap THROWS instead of returning what it has.
 */
const MAX_INSTALLATION_PAGES = 20;

/** Anchoring a multi-megabyte file is never a mechanical, low-ambiguity edit;
 * refuse rather than read it in and silently balloon memory/patch size. */
const MAX_CONTENT_BYTES = 1_000_000;

export interface GithubAppScmReaderOptions {
  api: GhApi;
}

export class GithubAppScmReader implements ScmReader, ScmInstallationReader {
  readonly #api: GhApi;

  constructor(options: GithubAppScmReaderOptions) {
    this.#api = options.api;
  }

  /**
   * Every repository the configured installation can see, read across pages and
   * deduplicated by full name.
   *
   * THREE WAYS THIS REFUSES TO UNDER-REPORT, because a short listing means a
   * repository silently goes unreviewed and nothing downstream can detect it:
   *  - a page whose shape we did not expect throws (via `#parse`);
   *  - the accumulated count is checked against the endpoint's own `total_count`;
   *  - exhausting the page cap throws rather than returning a partial list.
   * Any API error propagates untouched — `[]` is reserved for an installation that
   * genuinely has no repositories.
   */
  async listInstalledRepositories(): Promise<InstalledRepository[]> {
    const byName = new Map<string, InstalledRepository>();
    let total: number | null = null;

    for (let page = 1; page <= MAX_INSTALLATION_PAGES; page += 1) {
      const res = await this.#api("GET /installation/repositories", { per_page: PER_PAGE, page });
      const parsed = this.#parse(InstallationRepositories, res.data, `installation repositories page ${page}`);
      total = parsed.total_count;

      for (const repo of parsed.repositories) {
        byName.set(repo.full_name, {
          repository: repo.full_name,
          externalId: String(repo.id),
          defaultBranch: repo.default_branch,
          archived: repo.archived ?? false,
          disabled: repo.disabled ?? false,
        });
      }

      if (byName.size >= total) break;
      // A page that returned nothing new (or nothing at all) while the endpoint still
      // claims more repositories is a broken cursor, not the end of the listing.
      if (parsed.repositories.length === 0) {
        throw new Error(
          `github-app: installation listing stalled at ${byName.size} of ${total} repositories (page ${page} was empty) — refusing a partial installation view`,
        );
      }
    }

    if (total !== null && byName.size < total) {
      throw new Error(
        `github-app: installation listing read ${byName.size} of ${total} repositories within ${MAX_INSTALLATION_PAGES} pages — refusing a partial installation view`,
      );
    }
    return [...byName.values()];
  }

  /**
   * A branch's immutable head sha. 404 -> null (the branch does not exist, or has
   * no commits: a real answer meaning "nothing to review"). Every other failure
   * throws, so a scheduler can never mistake an outage for an empty branch.
   */
  async resolveBranchHead(repository: string, branch: string): Promise<string | null> {
    let res: { status: number; data: unknown };
    try {
      res = await this.#api(`GET /repos/${repository}/branches/${encodeURIComponent(branch)}`);
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }
    const parsed = this.#parse(BranchResponse, res.data, `branch ${repository}#${branch}`);
    if (!/^[0-9a-f]{40}$/.test(parsed.commit.sha)) {
      throw new Error(`github-app: branch ${repository}#${branch} head '${parsed.commit.sha}' is not a full commit sha`);
    }
    return parsed.commit.sha;
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
   * Immutable full-file content at `subject.commitSha`. Reports `complete:
   * false` with a stable reason for anything that is not a clean, safely
   * anchorable text read — never throws for an ordinary "cannot serve this
   * read" case, so one path's gap does not abort the caller's whole attempt.
   */
  async getFileContent(subject: SubjectRevision, path: string): Promise<FileContentResult> {
    try {
      const res = await this.#api(`GET /repos/${subject.repository}/contents/${path}`, { ref: subject.commitSha });
      if (Array.isArray(res.data)) {
        return { complete: false, path, reason: "not_found", detail: "path is a directory" };
      }
      const parsed = this.#parse(ContentsResponse, res.data, `contents of ${path}`);
      if (parsed.type !== "file") {
        return { complete: false, path, reason: "not_found", detail: `path is a ${parsed.type}` };
      }
      if (parsed.encoding !== "base64" || parsed.content === undefined) {
        // >1 MiB files come back with encoding "none" and empty content — the
        // API itself refuses to inline them; treat identically to oversized.
        return { complete: false, path, reason: "oversized", detail: "content not inline (file too large for the contents API)" };
      }
      const buffer = Buffer.from(parsed.content, "base64");
      if (buffer.byteLength > MAX_CONTENT_BYTES) {
        return { complete: false, path, reason: "oversized" };
      }
      if (isBinary(buffer)) {
        return { complete: false, path, reason: "binary" };
      }
      return { complete: true, path, content: buffer.toString("utf8") };
    } catch (err) {
      if (statusOf(err) === 404) return { complete: false, path, reason: "not_found" };
      return { complete: false, path, reason: "provider_error", detail: err instanceof Error ? err.message : String(err) };
    }
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

/** Heuristic binary sniff: a NUL byte in the first few KB never occurs in valid
 * UTF-8 text, which is the same signal `git diff`/most editors use. */
function isBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, Math.min(buffer.length, 8192));
  return probe.includes(0);
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
