import { SecretScanAnalyzer } from "../providers/analyzers/secret-scan.js";
import { SecretValidator } from "../providers/validation/secret-validator.js";
import type { PoisonPolicy } from "../domain/policy/types.js";
import { replayCorpus } from "./replay.js";
import { SYNTHETIC_CORPUS } from "./synthetic.js";

/**
 * `npm run corpus` — replays the synthetic corpus and prints the confusion
 * matrix and pre-registerable metrics. No database, no network: pure evidence
 * -> decision measurement.
 */

const POLICY: PoisonPolicy = { blockableDefectClasses: ["leaked-credential"], requireValidation: true };

function pct(n: number | null): string {
  return n === null ? "n/a" : `${(n * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const report = await replayCorpus(SYNTHETIC_CORPUS, {
    analyzers: [new SecretScanAnalyzer()],
    validator: new SecretValidator(),
    policy: POLICY,
  });

  console.log(`Corpus replay — ${report.total} cases (${report.positives} poison, ${report.negatives} clean)\n`);

  console.log("Confusion:");
  for (const [bucket, count] of Object.entries(report.confusion)) {
    console.log(`  ${bucket.padEnd(20)} ${count}`);
  }

  const m = report.metrics;
  console.log("\nMetrics:");
  console.log(`  block precision        ${pct(m.blockPrecision)}  (Wilson 95% lower: ${pct(m.blockPrecisionWilsonLower95)})`);
  console.log(`  false-block rate       ${pct(m.falseBlockRate)}`);
  console.log(`  severe-case recall     ${pct(m.severeRecall)}`);
  console.log(`  abstain rate           ${pct(m.abstainRate)}`);

  console.log("\nBy defect class:");
  for (const [cls, s] of Object.entries(report.byDefectClass)) {
    console.log(`  ${cls}: ${s.caught}/${s.positives} caught, ${s.missed} missed, ${s.abstained} abstained`);
  }

  if (report.regressions.length > 0) {
    console.log("\nRegressions vs expectedOutcome:");
    for (const r of report.regressions) console.log(`  ${r.id}: expected ${r.expected}, got ${r.actual}`);
    process.exitCode = 1;
  } else {
    console.log("\nNo regressions against expectedOutcome.");
  }
}

await main();
