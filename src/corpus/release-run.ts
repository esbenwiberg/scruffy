import { defaultAnalyzers, defaultValidator, RELEASE_STOP_CLASSES, RELEASE_SIGNOFF_CLASSES } from "../providers/registry.js";
import type { ReleasePolicy } from "../domain/policy/types.js";
import { pathToFileURL } from "node:url";
import { replayReleaseCorpus, type ReleaseReplayReport } from "./release-replay.js";
import { SEEDED_RELEASE_CORPUS } from "./release-corpus.js";

/**
 * `npm run corpus:release` — replays the seeded release corpus and prints outcome
 * accuracy and the safety metrics (unsafe ships, over-caution). No database, no
 * network: pure evidence -> aggregate outcome measurement. A single unsafe ship
 * fails the run.
 */

const POLICY: ReleasePolicy = {
  stopDefectClasses: [...RELEASE_STOP_CLASSES],
  signoffDefectClasses: [...RELEASE_SIGNOFF_CLASSES],
};

function pct(n: number | null): string {
  return n === null ? "n/a" : `${(n * 100).toFixed(1)}%`;
}

/**
 * Pure text + exit-code summary for the release replay. A single unsafe ship OR any
 * regression fails the run (exit 1). The "No regressions" success line is emitted
 * ONLY when the run is healthy overall, so a reassuring message never trails a hard
 * failure (e.g. an unsafe ship) in CI logs or scrollback.
 */
export function summarizeRelease(report: ReleaseReplayReport): { lines: string[]; exitCode: number } {
  const lines: string[] = [];
  lines.push(`Release replay — ${report.total} ranges\n`);
  lines.push("Confusion (truth -> actual):");
  for (const truth of ["ship", "sign-off-required", "stop"] as const) {
    const row = report.confusion[truth];
    lines.push(`  ${truth.padEnd(18)} ship=${row.ship} sign-off=${row["sign-off-required"]} stop=${row.stop} indet=${row.indeterminate}`);
  }

  const m = report.metrics;
  lines.push("\nMetrics:");
  lines.push(`  outcome accuracy   ${pct(m.outcomeAccuracy)}`);
  lines.push(`  unsafe ships       ${m.unsafeShips}`);
  lines.push(`  over-caution       ${m.overCaution}`);
  lines.push(`  indeterminates     ${m.indeterminates}`);

  let exitCode = 0;
  if (m.unsafeShips > 0) {
    lines.push(`\nFAIL: ${m.unsafeShips} range(s) that should have stopped/escalated were shipped.`);
    exitCode = 1;
  }
  if (report.regressions.length > 0) {
    lines.push("\nRegressions:");
    for (const r of report.regressions) lines.push(`  ${r.id}: expected ${r.expected}, got ${r.actual}`);
    exitCode = 1;
  }
  if (exitCode === 0) {
    lines.push("\nNo regressions against expected outcomes.");
  }
  return { lines, exitCode };
}

async function main(): Promise<void> {
  const report = await replayReleaseCorpus(SEEDED_RELEASE_CORPUS, {
    analyzers: defaultAnalyzers(),
    validator: defaultValidator(),
    policy: POLICY,
  });

  const { lines, exitCode } = summarizeRelease(report);
  for (const line of lines) console.log(line);
  if (exitCode !== 0) process.exitCode = exitCode;
}

// Only run when invoked as a script (`npm run corpus:release`); importing this
// module for its pure helpers (e.g. in tests) must not execute the replay.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
