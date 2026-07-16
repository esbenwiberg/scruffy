import { defaultAnalyzers, defaultValidator, defaultFixers, NIGHTLY_REPORTABLE_CLASSES, NIGHTLY_FIXABLE_CLASSES } from "../providers/registry.js";
import type { NightlyPolicy } from "../domain/policy/types.js";
import { replayNightlyCorpus } from "./nightly-replay.js";
import { SEEDED_NIGHTLY_CORPUS } from "./nightly-corpus.js";

/**
 * `npm run corpus:nightly` — replays the seeded nightly corpus and prints
 * disposition accuracy, surface precision/recall, and fix-generation rate. No
 * database, no network: pure evidence -> disposition measurement.
 */

const POLICY: NightlyPolicy = {
  reportableDefectClasses: [...NIGHTLY_REPORTABLE_CLASSES],
  fixableDefectClasses: [...NIGHTLY_FIXABLE_CLASSES],
};

function pct(n: number | null): string {
  return n === null ? "n/a" : `${(n * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const report = await replayNightlyCorpus(SEEDED_NIGHTLY_CORPUS, {
    analyzers: defaultAnalyzers(),
    validator: defaultValidator(),
    fixers: defaultFixers(),
    policy: POLICY,
  });

  const t = report.totals;
  console.log(`Nightly replay — ${report.total} ranges\n`);
  console.log("Totals:");
  console.log(`  expected surfaced   ${t.expectedSurfaced}`);
  console.log(`  actual surfaced     ${t.actualSurfaced}`);
  console.log(`  correct             ${t.correct}`);
  console.log(`  wrong disposition   ${t.wrongDisposition}`);
  console.log(`  missed              ${t.missed}`);
  console.log(`  false surface       ${t.falseSurface}`);
  console.log(`  fixes expected      ${t.fixesExpected}`);
  console.log(`  fixes generated     ${t.fixesGenerated}`);

  const m = report.metrics;
  console.log("\nMetrics:");
  console.log(`  surface precision   ${pct(m.surfacePrecision)}`);
  console.log(`  surface recall      ${pct(m.surfaceRecall)}`);
  console.log(`  disposition accuracy ${pct(m.dispositionAccuracy)}`);
  console.log(`  fix generation rate ${pct(m.fixGenerationRate)}`);

  if (report.regressions.length > 0) {
    console.log("\nRegressions:");
    for (const r of report.regressions) console.log(`  ${r.id} [${r.field}]: expected ${r.expected}, got ${r.actual}`);
    process.exitCode = 1;
  } else {
    console.log("\nNo regressions against expected summaries.");
  }
}

await main();
