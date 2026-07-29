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
import { parseReleaseReport, type ReleaseRiskReport } from "../src/domain/release/report.js";
import { CheckRunPayload } from "../src/effects/check-run.js";

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

/** The applicable lanes that are NOT in a clean state — the operator's holding gaps. */
function incompleteLanes(report: ReleaseRiskReport) {
  return report.evidenceLanes.filter(
    (lane) => lane.applicable && lane.status !== "complete" && lane.status !== "not-applicable",
  );
}

/**
 * Render the COMPLETE persisted report for a human operator. Pure over the parsed
 * report so it is unit-testable without a database (mirrors summarizeRelease). This
 * is the single rendering source — it reads the persisted `ReleaseRiskReport`, never
 * a reconstructed decision summary — so what the operator sees is exactly what was
 * committed and (via the same report) posted to GitHub. Coverage is printed BEFORE
 * finding totals so incomplete evidence can never hide behind a clean finding count.
 */
export function formatReleaseReport(report: ReleaseRiskReport): string[] {
  const d = report.decision;
  const lines: string[] = [];
  lines.push("Release risk report");
  lines.push(`  report    : ${report.reportId} (v${report.reportVersion})`);
  lines.push(`  policy    : ${report.policyVersion}`);
  lines.push(`  repository: ${report.subject.repository}`);
  lines.push(`  candidate : ${report.subject.candidateSha}`);
  lines.push(`  previous  : ${report.subject.previousReleaseSha ?? "(first release — candidate's own changes)"}`);
  lines.push(`  generated : ${report.generatedAt}`);
  lines.push(`  outcome   : ${d.outcome}${d.reasons.length ? `  (${d.reasons.join(", ")})` : ""}`);

  // Coverage FIRST — every declared lane with its status, required/applicable
  // posture, immutable subject SHA, observations and explicit gaps.
  lines.push("");
  lines.push("Coverage (evidence lanes):");
  for (const lane of report.evidenceLanes) {
    const posture = lane.required ? "required" : lane.applicable ? "optional" : "not-applicable";
    lines.push(`  - ${lane.laneId}: ${lane.status} [${posture}] @ ${lane.subjectSha}`);
    for (const obs of lane.observations) lines.push(`      · ${obs}`);
    for (const gap of lane.gaps) lines.push(`      gap: ${gap}`);
  }
  const missing = incompleteLanes(report);
  if (missing.length > 0) {
    lines.push(`  MISSING EVIDENCE: ${missing.map((l) => `${l.laneId} (${l.status})`).join(", ")}`);
  }

  lines.push("");
  lines.push(`Change summary: ${report.changeSummary || "(none provided)"}`);

  // Unresolved model risks — every one, with real citations (never dropped).
  lines.push("");
  if (report.risks.length === 0) {
    lines.push("Unresolved model risks: none");
  } else {
    lines.push(`Unresolved model risks (${report.risks.length}):`);
    for (const r of report.risks) {
      lines.push(`  - [${r.category}] ${r.scenario}`);
      lines.push(`      surface: ${r.affectedSurface} — impact: ${r.impact}`);
      lines.push(`      cites: ${r.citations.map((c) => `${c.path}:${c.line}`).join(", ")}`);
    }
  }

  // Deterministic findings — stopping/escalating dispositions before cleared counts.
  lines.push("");
  const { stopped, escalated, cleared, notRelevant } = d.summary;
  lines.push(`Findings — stopped: ${stopped}, escalated: ${escalated}, cleared: ${cleared}, not-relevant: ${notRelevant}`);
  for (const x of d.dispositions.filter((x) => x.effect === "stops" || x.effect === "escalates")) {
    lines.push(`  - [${x.effect}] ${x.defectClass} at ${x.region.path}:${x.region.startLine} (${x.reason})`);
  }

  lines.push("");
  lines.push("Shadow mode: the scruffy/release check is advisory and never blocks publication.");
  return lines;
}

/**
 * Verify the persisted report and the recorded advisory check AGREE, and make any
 * mismatch loud for the operator. The check is rendered from the report, so a
 * mismatch means an integrity fault, not a policy call — surface it, never hide it.
 */
export function checkReportCongruence(report: ReleaseRiskReport, check: CheckRunPayload): { agree: boolean; lines: string[] } {
  const problems: string[] = [];
  if (!check.summary.includes(report.reportId)) problems.push("advisory check is missing the report id");
  if (!check.summary.includes(report.subject.candidateSha)) problems.push("advisory check is missing the candidate SHA");
  if (!check.summary.includes(report.decision.outcome)) problems.push(`advisory check is missing the outcome '${report.decision.outcome}'`);
  for (const lane of report.evidenceLanes) {
    if (!check.summary.includes(`${lane.laneId}: ${lane.status}`)) {
      problems.push(`advisory check is missing coverage for ${lane.laneId} (${lane.status})`);
    }
  }
  if (problems.length === 0) {
    return { agree: true, lines: ["Report/check agreement: OK — candidate, report id, coverage and outcome congruent."] };
  }
  return { agree: false, lines: ["Report/check agreement: MISMATCH", ...problems.map((p) => `  ! ${p}`)] };
}

/**
 * Operator runbook for a controlled live GitHub shadow run. This command posts an
 * ADVISORY, non-required check only — it never publishes a release, never adds a
 * required status, and never blocks. A live shadow run requires operator GitHub
 * credentials against a controlled opted-in repository and is NOT executed from CI
 * or a pod; it is a deliberate operator action.
 */
export const SHADOW_RUNBOOK: string[] = [
  "",
  "── Operator runbook: controlled live GitHub shadow run ─────────────────────",
  "  1. Ensure local Postgres is up:            npm run db:up",
  "  2. Authenticate gh against the controlled opted-in repo (read + write scope).",
  "  3. Post the advisory (shadow) release check for a candidate:",
  "       npm run scruffy:release -- <owner/repo> <candidate-ref> [prev-release-ref]",
  "     (App-native check-run: SCRUFFY_SCM_WRITER=github-app; else a commit status.)",
  "  This is ADVISORY only: no release is published, no required check is added, and",
  "  the scruffy/release check never blocks. Run it by hand against the controlled",
  "  repository — it is not wired into CI or triggered automatically.",
];

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

    console.log("");
    console.log(`Run state : ${run.state}`);

    // Parse the ONE persisted report and print it in full — never reconstruct a
    // decision summary from release_decisions. The report is the single rendering
    // source, so what the operator reads is exactly what was committed and posted.
    const { rows: reportRows } = await pool.query<{ report: unknown }>(
      "select report from release_reports where run_id = $1",
      [run.id],
    );
    const rawReport = reportRows[0]?.report;
    if (rawReport === undefined) {
      console.log("No persisted report for this run — analysis did not reach a terminal report.");
    } else {
      // Never trust the blob: re-validate the stored report through the schema.
      const report = parseReleaseReport(rawReport);
      console.log("");
      for (const line of formatReleaseReport(report)) console.log(line);

      // Report/check agreement, from the persisted outbox effect (what was posted).
      const { rows: obxRows } = await pool.query<{ payload: unknown }>(
        "select payload from outbox where run_id = $1 and effect_type = 'check_run'",
        [run.id],
      );
      const rawPayload = obxRows[0]?.payload;
      console.log("");
      if (rawPayload === undefined) {
        console.log("Report/check agreement: no advisory check effect recorded for this run.");
      } else {
        const { agree, lines } = checkReportCongruence(report, CheckRunPayload.parse(rawPayload));
        for (const line of lines) console.log(line);
        if (!agree) process.exitCode = 1; // a mismatch is an integrity fault, not advisory
      }
    }

    console.log("");
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

    for (const line of SHADOW_RUNBOOK) console.log(line);
  });
}

// Only run when invoked as a script; importing this module for its pure helpers
// (e.g. in tests) must not execute the review.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
