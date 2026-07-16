import { defaultAnalyzers, defaultValidator, RELEASE_STOP_CLASSES, RELEASE_SIGNOFF_CLASSES } from "../providers/registry.js";
import type { ReleasePolicy } from "../domain/policy/types.js";
import { replayReleaseCorpus } from "./release-replay.js";
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

async function main(): Promise<void> {
  const report = await replayReleaseCorpus(SEEDED_RELEASE_CORPUS, {
    analyzers: defaultAnalyzers(),
    validator: defaultValidator(),
    policy: POLICY,
  });

  console.log(`Release replay — ${report.total} ranges\n`);
  console.log("Confusion (truth -> actual):");
  for (const truth of ["ship", "sign-off-required", "stop"] as const) {
    const row = report.confusion[truth];
    console.log(`  ${truth.padEnd(18)} ship=${row.ship} sign-off=${row["sign-off-required"]} stop=${row.stop} indet=${row.indeterminate}`);
  }

  const m = report.metrics;
  console.log("\nMetrics:");
  console.log(`  outcome accuracy   ${pct(m.outcomeAccuracy)}`);
  console.log(`  unsafe ships       ${m.unsafeShips}`);
  console.log(`  over-caution       ${m.overCaution}`);
  console.log(`  indeterminates     ${m.indeterminates}`);

  if (m.unsafeShips > 0) {
    console.log(`\nFAIL: ${m.unsafeShips} range(s) that should have stopped/escalated were shipped.`);
    process.exitCode = 1;
  }
  if (report.regressions.length > 0) {
    console.log("\nRegressions:");
    for (const r of report.regressions) console.log(`  ${r.id}: expected ${r.expected}, got ${r.actual}`);
    process.exitCode = 1;
  } else {
    console.log("\nNo regressions against expected outcomes.");
  }
}

await main();
