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
import { renderMorningForReport } from "../src/app/fix-reconciler.js";
import { nightlyReviewTitle } from "../src/domain/findings/morning-summary.js";
import type { MorningSummary } from "../src/domain/findings/morning-summary.js";
import type { NightlyEvidenceSnapshot } from "../src/app/nightly-evidence-query.js";
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

export interface ManualNightlyReport {
  /** The hosted morning render for this candidate, when the run planned work. */
  morning: MorningSummary | null;
  /** Durable nightly evidence for this candidate, through the read-only query. */
  snapshot: NightlyEvidenceSnapshot;
  headSha: string;
  runState: string;
  /** The last COMPLETE review head for the branch, or null while none exists. */
  completeWatermark: string | null;
  flushed: number;
  /** Outbox rows that exhausted their retries (all repositories). */
  deadLettered: number;
  writerBackend: string;
}

/**
 * The manual command's output, rendered from the SAME durable state and the SAME
 * renderer the hosted path uses.
 *
 * Congruence is the point. A controlled run or a backfill must not tell an operator
 * a different story from the scheduled run that follows it, so whenever the night
 * produced a work graph this prints the parent/check bytes verbatim — coverage
 * first, every issue and PR linked, failures loud — and only adds the operational
 * facts a terminal has that GitHub does not (which watermark moved, how many effects
 * dispatched, what dead-lettered).
 *
 * With no work graph (a complete night that found nothing) there is nothing to link,
 * so the summary is built from the evidence snapshot instead — still coverage first,
 * and still incapable of titling an incomplete range as clean, because
 * `nightlyReviewTitle` is the same function the check uses.
 */
export function renderManualNightly(report: ManualNightlyReport): string[] {
  const lines: string[] = [];
  if (report.morning !== null) {
    lines.push(report.morning.title, "", report.morning.body);
  } else {
    const { snapshot } = report;
    const gaps = snapshot.reports.flatMap((r) => r.coverageGaps);
    const proposals = snapshot.reports.reduce((total, r) => total + r.summary.proposals, 0);
    lines.push(
      nightlyReviewTitle({
        requiredCoverageComplete: snapshot.requiredCoverageComplete,
        requiredGaps: gaps.length,
        surfaced: snapshot.surfacedFindings,
        proposals,
        openItems: snapshot.openFindings + snapshot.awaitingVerification,
      }),
      "",
      "## Coverage",
      "",
      snapshot.requiredCoverageComplete
        ? "Required analyzer coverage is **complete** for this range."
        : `Required analyzer coverage is **INCOMPLETE** — ${gaps.map((g) => `${g.analyzerId}: ${g.code}`).join("; ")}` +
          " (the complete-review watermark is HELD; this range stays owed).",
      "",
      "## Findings",
      "",
      `- surfaced (human work): ${snapshot.surfacedFindings}`,
      `- fix proposals: ${proposals}`,
      "",
      "## Work items",
      "",
      snapshot.reports.length === 0
        ? "- No durable nightly report exists for this candidate."
        : "- None: this run planned no work items, so no issue was created.",
    );
  }

  lines.push(
    "",
    "## Run",
    "",
    `- Reviewed candidate: \`${report.headSha}\` (run state \`${report.runState}\`)`,
    // The watermark is the honest answer to "is this range done": an incomplete run
    // leaves it behind the head it just attempted.
    report.completeWatermark === null
      ? "- Complete-review watermark: none yet — no range has been completely reviewed on this branch."
      : `- Complete-review watermark: \`${report.completeWatermark}\`` +
        (report.completeWatermark === report.headSha ? " (advanced to this candidate)" : " (HELD behind this candidate)"),
    `- Effects dispatched: ${report.flushed} (writer: ${report.writerBackend})`,
  );
  if (report.deadLettered > 0) {
    lines.push(
      `- **${report.deadLettered} outbox row(s) dead-lettered** (all repositories) — some GitHub work was NOT delivered;` +
        " the durable report above still describes what Scruffy intended.",
    );
  }
  return lines;
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

    // Everything printed below comes from the DURABLE report and lifecycle state —
    // the same rows the hosted parent issue and `scruffy/nightly` check are rendered
    // from — rather than from this process's in-memory decision.
    const view = (await scruffy.fixes.openReports(50)).find((candidate) => candidate.headSha === headSha) ?? null;
    const snapshot = await scruffy.nightlyEvidence.forCandidate(repo, headSha);
    const progress = await scruffy.runs.getReviewProgress(repo, branch);

    console.log("");
    for (const line of renderManualNightly({
      morning: view === null ? null : renderMorningForReport(view),
      snapshot,
      headSha,
      runState: run.state,
      completeWatermark: progress?.lastCompleteHead ?? null,
      flushed,
      deadLettered: await scruffy.outbox.countFailed(),
      writerBackend,
    })) {
      console.log(line);
    }
    console.log(`\nBranch    : ${htmlUrl}`);

    // Honesty: a proposed fix wants a REAL PR, which the gh-cli writer cannot open.
    // That effect will have failed to dispatch and dead-lettered — say so plainly.
    const proposedFixes = snapshot.reports.reduce((total, r) => total + r.summary.proposals, 0);
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
