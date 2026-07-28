import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SystemClock, UuidIdGenerator } from "../src/platform/clock.js";
import { createPool } from "../src/persistence/db.js";
import { migrate } from "../src/persistence/migrate.js";
import { Scruffy } from "../src/app/scruffy.js";
import {
  createScmReader,
  createScmWriter,
  resolveScmReaderBackend,
  resolveScmWriterBackend,
} from "../src/providers/scm/factory.js";
import { defaultAnalyzers, defaultValidator, defaultFixers, defaultPolicy } from "../src/providers/registry.js";
import { withPool } from "./review-pr.js";

/**
 * `npm run scruffy:nightly -- <owner/repo> <branch> [head-sha]` — run the NIGHTLY
 * gate against a branch and drain its effects. Scheduler-shaped entry point (a cron
 * would call this), but manual here so a nightly can be proven IRL. Reuses the `gh`
 * session for read + write by default; requires local Postgres (`npm run db:up`).
 *
 * The nightly gate NEVER blocks — it reviews (watermark, head] and proposes:
 * suppress / report / propose_fix. Re-running an unchanged head is an idempotent
 * no-op (base == head -> up-to-date). The base defaults to the branch's stored
 * watermark; the first-ever run has a null base and reviews the head commit itself.
 *
 * WRITER HONESTY (load-bearing): under the default `gh-cli` writer the summary
 * check-run renders as a shadow commit status (works), but a `propose_fix`
 * disposition wants a REAL fix PR, and `openPullRequest` is not enabled in the
 * gh-cli adapter — that effect throws and dead-letters. Opening fix PRs needs
 * `SCRUFFY_SCM_WRITER=github-app` once the App is registered. The script warns
 * loudly rather than letting a proposed fix silently vanish.
 */

function gh(args: string[]): unknown {
  const out = execFileSync("gh", args, { encoding: "utf8" });
  return JSON.parse(out);
}

/**
 * Minimal shape we depend on from `gh api repos/.../commits/{ref}`: a full 40-char
 * sha and the commit URL. Validated before use so an error object or unexpected
 * payload returned with exit 0 fails friendly here instead of crashing later.
 */
export const CommitPayload = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/, "expected a full 40-char sha"),
  html_url: z.string().min(1),
});

/**
 * A ref (branch name or sha) safe to interpolate into a `gh api` path: the
 * GitHub-legal ref charset, no `..` traversal, no query/fragment splice, no
 * control chars. Rejected refs never reach the URL. Mirrors the SubjectRevision
 * repository allowlist rationale — the boundary is closed at parse time.
 */
export function isSafeRef(ref: string): boolean {
  if (ref.length === 0 || ref.length > 255) return false;
  if (ref.includes("..")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref);
}

/**
 * Resolve a branch/sha ref to its head sha (full 40-char) + commit URL via the
 * `gh` session. Both the transport error and an unexpected shape map to the same
 * friendly message + exit 1. `runGh` is injectable so the error paths are testable.
 */
export function resolveBranchHead(
  runGh: (args: string[]) => unknown,
  repo: string,
  ref: string,
): { headSha: string; htmlUrl: string } {
  let raw: unknown;
  try {
    raw = runGh(["api", `repos/${repo}/commits/${ref}`]);
  } catch (err) {
    console.error(`Could not read ${repo}@${ref} via gh — is gh authenticated and the ref accessible?`);
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
  const parsed = CommitPayload.safeParse(raw);
  if (!parsed.success) {
    console.error(`Could not read ${repo}@${ref} via gh — unexpected response shape (no 40-char sha).`);
    process.exit(1);
  }
  return { headSha: parsed.data.sha, htmlUrl: parsed.data.html_url };
}

function usage(): never {
  console.error("usage: npm run scruffy:nightly -- <owner/repo> <branch> [head-sha]");
  process.exit(2);
}

async function main(): Promise<void> {
  const [repo, branch, headArg] = process.argv.slice(2);
  if (!repo || !repo.includes("/") || !branch || !isSafeRef(branch)) usage();
  if (headArg !== undefined && !/^[0-9a-f]{40}$/.test(headArg)) usage();

  // Resolve the head sha + commit URL. When an explicit head sha is given we
  // resolve THAT ref (GitHub returns the sha itself); otherwise the branch tip.
  const ref = headArg ?? branch;
  const { headSha, htmlUrl } = resolveBranchHead(gh, repo, ref);

  const writerBackend = resolveScmWriterBackend();
  const readerBackend = resolveScmReaderBackend();

  await withPool(createPool, migrate, async (pool) => {
    const scruffy = new Scruffy({
      pool,
      clock: new SystemClock(),
      ids: new UuidIdGenerator(),
      policy: defaultPolicy(),
      // Reader + writer both come from the factory: gh-cli by default (the
      // developer's own session), github-app when SCRUFFY_SCM_READER/_WRITER say so.
      scmReader: createScmReader(readerBackend, { targetUrl: htmlUrl }),
      scmWriter: createScmWriter(writerBackend, { targetUrl: htmlUrl }),
      analyzers: defaultAnalyzers(),
      validator: defaultValidator(),
      fixers: defaultFixers(),
      webhookSecret: "unused-in-manual-trigger",
    });

    console.log(
      `Nightly review of ${repo}@${branch} up to ${headSha.slice(0, 12)} … (reader: ${readerBackend}, writer: ${writerBackend})`,
    );

    // base omitted => the nightly service uses the branch watermark (null first time).
    const result = await scruffy.runNightly({ repository: repo, branch, head: headSha });

    if (!result.reviewed) {
      // base == head: the watermark already covers this head. Idempotent no-op.
      console.log(`\nNothing to review — ${branch} is up-to-date at ${headSha.slice(0, 12)} (watermark unchanged).`);
      return;
    }

    const run = result.run;
    const flushed = await scruffy.flushEffects();

    const { rows } = await pool.query<{ dispositions: unknown; summary: unknown; coverage: unknown }>(
      "select dispositions, summary, coverage from nightly_decisions where run_id = $1",
      [run.id],
    );
    const summary = rows[0]?.summary as { reported?: number; proposedFixes?: number; suppressed?: number } | undefined;
    const coverage = rows[0]?.coverage as { complete?: boolean; gaps?: { analyzerId: string; code: string }[] } | undefined;

    console.log("");
    console.log(`Range     : ${run.baseSha ? run.baseSha.slice(0, 12) : "(first review)"} … ${headSha.slice(0, 12)}`);
    console.log(`Run state : ${run.state}`);
    if (summary) {
      console.log(
        `Dispositions: report ${summary.reported ?? 0}, propose_fix ${summary.proposedFixes ?? 0}, suppress ${summary.suppressed ?? 0}`,
      );
    } else if (run.state === "indeterminate") {
      console.log("Dispositions: none — analysis could not run (abstained; watermark held for re-review).");
    }
    // Coverage is the difference between "reviewed and clean" and "could not look".
    // Print it plainly: an incomplete run holds the complete-review watermark, so a
    // quiet output here must never read as a clean night.
    if (coverage) {
      const gaps = coverage.gaps ?? [];
      console.log(
        gaps.length === 0
          ? "Coverage  : complete"
          : `Coverage  : INCOMPLETE — ${gaps.map((g) => `${g.analyzerId}: ${g.code}`).join("; ")} ` +
            `(complete-review watermark held; range stays owed)`,
      );
    }
    console.log(`Effects   : ${flushed} dispatched to GitHub (writer: ${writerBackend})`);
    console.log(`Branch    : ${htmlUrl}`);

    // Honesty: a proposed fix wants a REAL PR, which the gh-cli writer cannot open.
    // That effect will have failed to dispatch and dead-lettered — say so plainly.
    const proposedFixes = summary?.proposedFixes ?? 0;
    if (writerBackend === "gh-cli" && proposedFixes > 0) {
      console.error(
        `\nWARNING: ${proposedFixes} fix PR(s) were proposed but the gh-cli writer cannot open PRs ` +
          `(openPullRequest is not enabled) — those effects dead-lettered. ` +
          `Set SCRUFFY_SCM_WRITER=github-app (once the App is registered) to actually open fix PRs.`,
      );
      process.exitCode = 1;
    }
  });
}

// Only run when invoked as a script; importing this module for its pure helpers
// (e.g. in tests) must not execute the review.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
