import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SystemClock, UuidIdGenerator } from "../src/platform/clock.js";
import { createPool } from "../src/persistence/db.js";
import { migrate } from "../src/persistence/migrate.js";
import { Scruffy } from "../src/app/scruffy.js";
import { createScmReader, resolveScmReaderBackend } from "../src/providers/scm/factory.js";
import type { ScmWriter } from "../src/providers/scm/port.js";
import {
  defaultAnalyzers,
  defaultValidator,
  defaultFixers,
  defaultPolicy,
  releaseRiskAnalyst,
} from "../src/providers/registry.js";
import { withPool } from "./review-pr.js";
import { isSafeRef, resolveBranchHead } from "./nightly-review.js";
import { parseReleaseReport, type ReleaseRiskReport } from "../src/domain/release/report.js";
import { CheckRunPayload } from "../src/effects/check-run.js";
import { createModelProvider, resolveBackend } from "../src/providers/models/factory.js";
import { signoffResponsibility } from "../src/domain/release/signoff.js";

/**
 * `npm run scruffy:release -- <owner/repo> <candidate-ref> [prev-release-ref]` —
 * run the RELEASE gate over the range (prev-release, candidate] as a CD step.
 * It reads repository evidence, persists one report, prints it, and writes
 * GitHub Actions job-summary/output files when those paths are present. It does
 * NOT post a commit status/check and therefore never puts the heavyweight
 * release narrative onto a pull request sharing the candidate SHA.
 *
 * The release gate is the LAST gate before deployment: it produces one aggregate
 * outcome — ship / sign-off-required / stop / indeterminate. Uncertainty maps to
 * sign-off-required, not a guessed ship. The next workflow job routes that
 * outcome to automatic deployment, protected-environment approval, or failure.
 *
 * When `prev-release-ref` is omitted the range is the candidate's own full change
 * set (a first-ever release). Otherwise it is resolved to a sha and used as the
 * lower bound. Both refs are validated (isSafeRef) before they reach a `gh api`
 * path, and resolved to full shas via the shared resolver.
 *
 * WRITE BOUNDARY: this command injects a refusing SCM writer and does not drain
 * outbox effects. It needs repository read credentials only. Publication and
 * approval are separate CD jobs, each with their own narrower authority.
 */

function gh(args: string[]): unknown {
  const out = execFileSync("gh", args, { encoding: "utf8" });
  return JSON.parse(out);
}

/** CD analysis has no SCM write authority. Any accidental effect fails loudly. */
function reportOnlyWriter(): ScmWriter {
  const refuse = async (): Promise<never> => {
    throw new Error("release CD analysis is report-only and cannot write SCM effects");
  };
  return {
    upsertCheckRun: refuse,
    openPullRequest: refuse,
    upsertIssue: refuse,
    linkChildIssue: refuse,
  };
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
  console.error(
    "usage: npm run scruffy:release -- <owner/repo> <candidate-ref> [prev-release-ref]",
  );
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
  lines.push(
    `  previous  : ${report.subject.previousReleaseSha ?? "(first release — candidate's own changes)"}`,
  );
  lines.push(`  generated : ${report.generatedAt}`);
  lines.push(`  outcome   : ${d.outcome}${d.reasons.length ? `  (${d.reasons.join(", ")})` : ""}`);
  if (d.outcome === "sign-off-required") {
    lines.push("");
    lines.push(
      "HUMAN RESPONSIBILITY — exception approval does not transfer responsibility to Scruffy:",
    );
    lines.push(`  ${signoffResponsibility(report)}`);
  }

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
      lines.push(`      affected surface : ${r.affectedSurface}`);
      lines.push(
        `      blast radius     : ${r.blastRadius ?? "(not established by this report version)"}`,
      );
      lines.push(`      impact           : ${r.impact}`);
      lines.push(`      detectability    : ${r.detectability ?? "(not established)"}`);
      lines.push(`      reversibility    : ${r.reversibility ?? "(not established)"}`);
      lines.push(`      rollback         : ${r.rollback ?? "(not established)"}`);
      lines.push(`      uncertainty      : ${r.uncertainty ?? "(none stated)"}`);
      lines.push(`      supporting       : ${r.supportingEvidence?.join("; ") || "(none stated)"}`);
      lines.push(
        `      contradicting    : ${r.contradictingEvidence?.join("; ") || "(none stated)"}`,
      );
      lines.push(
        `      citations        : ${r.citations.map((c) => `${c.path}:${c.line}`).join(", ")}`,
      );
    }
  }

  // Factual context is deliberately separate from release authority. It is
  // persisted in the report, but neither bug backlog nor unrelated PR volume
  // changes the decision above.
  lines.push("");
  lines.push("Outstanding work (context only — does not change the release outcome):");
  const work = report.outstandingWork;
  if (work === undefined) {
    lines.push("  Not recorded in this report version.");
  } else {
    lines.push(
      `  Repository context: ${work.repository.status}; ${work.repository.bugIssues.length} open bug issue(s), ` +
        `${work.repository.openPullRequests.length} open PR(s).`,
    );
    for (const gap of work.repository.gaps) lines.push(`    gap: ${gap}`);
    for (const issue of work.repository.bugIssues) {
      lines.push(`    - bug #${issue.number}: ${singleLine(issue.title)} — ${issue.url}`);
    }
    if (work.repository.openPullRequests.length > 0) {
      lines.push(
        "    Open PRs are future work; their metadata is retained in the report snapshot but collapsed in deployment review.",
      );
    }

    lines.push(
      `  Scruffy nightly context: ${work.nightly.status}; ${work.nightly.reportsConsidered} report(s), ` +
        `${work.nightly.findings.length} unresolved tracked finding(s).`,
    );
    for (const gap of work.nightly.gaps) lines.push(`    gap: ${gap}`);
    for (const issue of work.nightly.parentIssues)
      lines.push(`    - nightly issue #${issue.number}: ${issue.url}`);
    for (const finding of work.nightly.findings) {
      lines.push(
        `    - [${finding.resolution}] ${finding.defectClass} at ${finding.path}:${finding.startLine}` +
          (finding.issue
            ? ` — issue #${finding.issue.number}: ${finding.issue.url}`
            : " — issue not published"),
      );
      if (finding.proposal !== null) {
        const pr = finding.proposal.pullRequest;
        lines.push(
          `        fix: delivery=${finding.proposal.delivery}, ci=${finding.proposal.ci}, merge=${finding.proposal.merge}` +
            (pr ? ` — PR #${pr.number}: ${pr.url}` : "") +
            (finding.proposal.deliveryError
              ? ` — error: ${singleLine(finding.proposal.deliveryError)}`
              : ""),
        );
      }
    }
  }

  // Deterministic findings — stopping/escalating dispositions before cleared counts.
  lines.push("");
  const { stopped, escalated, cleared, notRelevant } = d.summary;
  lines.push(
    `Findings — stopped: ${stopped}, escalated: ${escalated}, cleared: ${cleared}, not-relevant: ${notRelevant}`,
  );
  for (const x of d.dispositions.filter((x) => x.effect === "stops" || x.effect === "escalates")) {
    lines.push(
      `  - [${x.effect}] ${x.defectClass} at ${x.region.path}:${x.region.startLine} (${x.reason})`,
    );
  }

  lines.push("");
  lines.push("CD surface: this report is emitted to the deployment job; no pull-request check is posted.");
  return lines;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim();
}

/**
 * Verify the persisted report and the recorded advisory check AGREE, and make any
 * mismatch loud for the operator. The check is rendered from the report, so a
 * mismatch means an integrity fault, not a policy call — surface it, never hide it.
 */
export function checkReportCongruence(
  report: ReleaseRiskReport,
  check: CheckRunPayload,
): { agree: boolean; lines: string[] } {
  const problems: string[] = [];
  if (!check.summary.includes(report.reportId))
    problems.push("advisory check is missing the report id");
  if (!check.summary.includes(report.subject.candidateSha))
    problems.push("advisory check is missing the candidate SHA");
  if (!check.summary.includes(report.decision.outcome))
    problems.push(`advisory check is missing the outcome '${report.decision.outcome}'`);
  if (
    report.decision.outcome === "sign-off-required" &&
    !check.summary.includes(signoffResponsibility(report))
  ) {
    problems.push("advisory check is missing the exact human responsibility statement");
  }
  for (const lane of report.evidenceLanes) {
    if (!check.summary.includes(`${lane.laneId}: ${lane.status}`)) {
      problems.push(`advisory check is missing coverage for ${lane.laneId} (${lane.status})`);
    }
  }
  if (problems.length === 0) {
    return {
      agree: true,
      lines: ["Report/check agreement: OK — candidate, report id, coverage and outcome congruent."],
    };
  }
  return {
    agree: false,
    lines: ["Report/check agreement: MISMATCH", ...problems.map((p) => `  ! ${p}`)],
  };
}

/** Markdown written to GitHub's deployment-job summary, never a PR check. */
export function formatGithubStepSummary(report: ReleaseRiskReport): string {
  const body = formatReleaseReport(report)
    .map((line) => line.replaceAll("~~~~", "~ ~ ~ ~"))
    .join("\n");
  return [
    "## Scruffy release risk report",
    "",
    `**Outcome:** \`${report.decision.outcome}\`  `,
    `**Candidate:** \`${report.subject.candidateSha}\`  `,
    `**Report:** \`${report.reportId}\``,
    "",
    "<details open>",
    "<summary>Full deployment evidence</summary>",
    "",
    "~~~~text",
    body,
    "~~~~",
    "",
    "</details>",
    "",
  ].join("\n");
}

/** Stable scalar outputs consumed by later CD jobs. */
export function formatGithubOutputs(report: ReleaseRiskReport): string {
  return [
    `outcome=${report.decision.outcome}`,
    `report_id=${report.reportId}`,
    `candidate_sha=${report.subject.candidateSha}`,
    `signoff_required=${report.decision.outcome === "sign-off-required"}`,
  ].join("\n");
}

/** Analysis succeeds for ship/sign-off so the workflow can route to its next job. */
export function releaseCdExitCode(outcome: ReleaseRiskReport["decision"]["outcome"]): 0 | 1 {
  return outcome === "ship" || outcome === "sign-off-required" ? 0 : 1;
}

function writeGithubActionsFiles(report: ReleaseRiskReport): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, formatGithubStepSummary(report), "utf8");
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) appendFileSync(outputPath, `${formatGithubOutputs(report)}\n`, "utf8");
}

export const CD_RUNBOOK: string[] = [
  "",
  "── CD release-risk step ────────────────────────────────────────────────────",
  "  1. Run only after merge and artifact creation, against an immutable SHA.",
  "  2. Ensure repository read credentials and the selected model backend exist.",
  "  3. Execute:",
  "       npm run scruffy:release -- <owner/repo> <candidate-sha> [previous-deployed-sha]",
  "  4. Route output=ship directly to deployment; route sign-off-required through",
  "     a protected environment; fail stop and indeterminate.",
  "  The command writes GITHUB_STEP_SUMMARY/GITHUB_OUTPUT when Actions provides",
  "  them. It never posts a commit status or check and never writes to a PR.",
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

  const readerBackend = resolveScmReaderBackend();
  const modelBackend = resolveBackend();
  // The fake/unset default must not masquerade as a real release-risk review.
  // A live analyst is wired only through an explicitly selected real backend.
  const model = modelBackend === "fake" ? undefined : await createModelProvider(modelBackend);

  await withPool(createPool, migrate, async (pool) => {
    const scruffy = new Scruffy({
      pool,
      clock: new SystemClock(),
      ids: new UuidIdGenerator(),
      policy: defaultPolicy(),
      // CD analysis reads repository evidence but has no SCM write authority.
      scmReader: createScmReader(readerBackend, { targetUrl: htmlUrl }),
      scmWriter: reportOnlyWriter(),
      analyzers: defaultAnalyzers(),
      validator: defaultValidator(),
      fixers: defaultFixers(),
      ...(model !== undefined ? { model, releaseRisk: releaseRiskAnalyst(model) } : {}),
      // Release presentation belongs to CD. Never attach this heavyweight report
      // to a commit check that can surface on a pull request sharing the SHA.
      publishReleaseCheck: false,
      webhookSecret: "unused-in-manual-trigger",
    });

    console.log(
      `Release review of ${repo}@${candidateRef} (${candidateSha.slice(0, 12)}) ` +
        `from ${prevRef === null ? "(first release — candidate's own changes)" : `${prevRef} (${prevSha!.slice(0, 12)})`} ` +
        `… (reader: ${readerBackend}, surface: cd-job, model: ${modelBackend})`,
    );

    const run = await scruffy.runRelease({
      repository: repo,
      candidate: candidateSha,
      prevRelease: prevSha,
    });

    console.log("");
    console.log(`Run state : ${run.state}`);

    // Parse the ONE persisted report and print it in full — never reconstruct a
    // decision summary from release_decisions. The report is the single rendering
    // source for terminal output and the GitHub deployment-job summary.
    const { rows: reportRows } = await pool.query<{ report: unknown }>(
      "select report from release_reports where run_id = $1",
      [run.id],
    );
    const rawReport = reportRows[0]?.report;
    if (rawReport === undefined) {
      console.log("No persisted report for this run — analysis did not reach a terminal report.");
      process.exitCode = 1;
    } else {
      // Never trust the blob: re-validate the stored report through the schema.
      const report = parseReleaseReport(rawReport);
      console.log("");
      for (const line of formatReleaseReport(report)) console.log(line);
      writeGithubActionsFiles(report);
      console.log("");
      console.log("Release surface: CD job summary/output only; 0 SCM effects emitted.");
      console.log(`Candidate      : ${htmlUrl}`);
      if (releaseCdExitCode(report.decision.outcome) !== 0) process.exitCode = 1;
    }

    for (const line of CD_RUNBOOK) console.log(line);
  });
}

// Only run when invoked as a script; importing this module for its pure helpers
// (e.g. in tests) must not execute the review.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
