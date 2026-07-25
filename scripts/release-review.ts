import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
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
import { isSafeRef, resolveBranchHead } from "./nightly-review.js";

/**
 * `npm run scruffy:release -- <owner/repo> <candidate-ref> [prev-release-ref]` —
 * run the RELEASE gate over the range (prev-release, candidate] and drain its
 * effects. Release-candidate-shaped entry point (a controlled draft-release
 * protocol would call this), but manual here so a release can be proven IRL.
 * Reuses the `gh` session for read + write by default; requires local Postgres
 * (`npm run db:up`).
 *
 * The release gate is the LAST gate: it produces ONE aggregate outcome over the
 * range — ship / sign-off-required / stop — and NEVER blocks (the check is
 * shadow/advisory in the skeleton). Uncertainty maps to sign-off-required, not
 * abstention — a last gate does not get to shrug. Infra failure that stops
 * analysis maps to indeterminate (a neutral abstain), never a fabricated ship.
 *
 * When `prev-release-ref` is omitted the range is the candidate's own full change
 * set (a first-ever release). Otherwise it is resolved to a sha and used as the
 * lower bound. Both refs are validated (isSafeRef) before they reach a `gh api`
 * path, and resolved to full shas via the shared resolver.
 *
 * WRITER NOTE: unlike nightly, release emits NO fix PR — only the shadow
 * `scruffy/release` check. Under the default gh-cli writer that renders as a
 * commit status on the candidate; under `SCRUFFY_SCM_WRITER=github-app` it lands
 * as a real native check-run. Either way it is non-required and cannot block.
 */

function gh(args: string[]): unknown {
  const out = execFileSync("gh", args, { encoding: "utf8" });
  return JSON.parse(out);
}

export interface ReleaseArgs {
  repo: string;
  candidateRef: string;
  /** null when omitted — a first-ever release over the candidate's own changes. */
  prevRef: string | null;
}

/**
 * Parse + validate the positional args WITHOUT touching process state, so the
 * boundary rules are unit-testable. Returns null on any violation (caller maps
 * that to usage()). Both refs are interpolated into a `gh api` path, so an unsafe
 * ref is rejected here before it can reach the URL — same rationale as nightly.
 */
export function parseReleaseArgs(argv: readonly string[]): ReleaseArgs | null {
  const [repo, candidateRef, prevRef] = argv;
  if (!repo || !repo.includes("/") || !candidateRef || !isSafeRef(candidateRef)) return null;
  if (prevRef !== undefined && !isSafeRef(prevRef)) return null;
  return { repo, candidateRef, prevRef: prevRef ?? null };
}

function usage(): never {
  console.error("usage: npm run scruffy:release -- <owner/repo> <candidate-ref> [prev-release-ref]");
  process.exit(2);
}

async function main(): Promise<void> {
  const parsed = parseReleaseArgs(process.argv.slice(2));
  if (!parsed) usage();
  const { repo, candidateRef, prevRef } = parsed;

  // Resolve the candidate ref (branch/tag/sha) to a full 40-char sha + URL. When a
  // previous release is given, resolve it too — its sha becomes the range's lower
  // bound (base_sha). Omitted => null => the candidate's own full change set.
  const { headSha: candidateSha, htmlUrl } = resolveBranchHead(gh, repo, candidateRef);
  const prevSha = prevRef === null ? null : resolveBranchHead(gh, repo, prevRef).headSha;

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
      `Release review of ${repo}@${candidateRef} (${candidateSha.slice(0, 12)}) ` +
        `from ${prevRef === null ? "(first release — candidate's own changes)" : `${prevRef} (${prevSha!.slice(0, 12)})`} ` +
        `… (reader: ${readerBackend}, writer: ${writerBackend})`,
    );

    const run = await scruffy.runRelease({ repository: repo, candidate: candidateSha, prevRelease: prevSha });
    const flushed = await scruffy.flushEffects();

    const { rows } = await pool.query<{ outcome: string; reasons: unknown; dispositions: unknown; summary: unknown }>(
      "select outcome, reasons, dispositions, summary from release_decisions where run_id = $1",
      [run.id],
    );
    const decision = rows[0];
    const summary = decision?.summary as
      | { stopped?: number; escalated?: number; cleared?: number; notRelevant?: number }
      | undefined;

    console.log("");
    console.log(`Range     : ${prevSha ? prevSha.slice(0, 12) : "(first release)"} … ${candidateSha.slice(0, 12)}`);
    console.log(`Run state : ${run.state}`);
    if (decision) {
      const reasons = Array.isArray(decision.reasons) ? decision.reasons.join(", ") : "";
      console.log(`Outcome   : ${decision.outcome}${reasons ? `  (${reasons})` : ""}`);
      if (summary) {
        console.log(
          `Findings  : stopped ${summary.stopped ?? 0}, escalated ${summary.escalated ?? 0}, ` +
            `cleared ${summary.cleared ?? 0}, not-relevant ${summary.notRelevant ?? 0}`,
        );
      }
    } else if (run.state === "indeterminate") {
      console.log("Outcome   : indeterminate — analysis could not run (abstained, no fabricated ship/stop).");
    }
    console.log(`Effects   : ${flushed} dispatched to GitHub (writer: ${writerBackend})`);

    // Read the shadow check back so we print exactly what landed on the candidate.
    // Under the App writer it is a native check-run; under gh-cli it is a commit
    // status. Try both; non-fatal if neither read succeeds (effects count + the
    // decision above are the source of truth).
    try {
      const rawRuns = gh(["api", `repos/${repo}/commits/${candidateSha}/check-runs`]);
      const check = (rawRuns as { check_runs?: { name: string; conclusion: string | null }[] }).check_runs?.find(
        (c) => c.name === "scruffy/release",
      );
      if (check) console.log(`Check     : ${check.conclusion ?? "pending"}  (scruffy/release — shadow, non-required)`);
    } catch {
      // ignore — fall through to the status read below
    }
    try {
      const rawStatuses = gh(["api", `repos/${repo}/commits/${candidateSha}/statuses`]);
      const status = (rawStatuses as { state: string; context: string }[]).find((s) => s.context === "scruffy/release");
      if (status) console.log(`Status    : ${status.state}  (context scruffy/release — shadow, non-required)`);
    } catch {
      // Non-fatal: the decision + effect count above are the source of truth.
    }
    console.log(`Candidate : ${htmlUrl}`);

    if (flushed === 0) {
      console.error("\nWARNING: no effect was dispatched — the shadow check may not have been posted. Check writer access.");
      process.exitCode = 1;
    }
  });
}

// Only run when invoked as a script; importing this module for its pure helpers
// (e.g. in tests) must not execute the review.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
