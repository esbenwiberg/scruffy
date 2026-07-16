import {
  defaultAnalyzers,
  defaultValidator,
  defaultFixers,
  modelAnalyzers,
  POISON_BLOCKABLE_CLASSES,
  NIGHTLY_REPORTABLE_CLASSES,
  NIGHTLY_FIXABLE_CLASSES,
  RELEASE_STOP_CLASSES,
  RELEASE_SIGNOFF_CLASSES,
} from "../providers/registry.js";
import type { PoisonPolicy, NightlyPolicy, ReleasePolicy } from "../domain/policy/types.js";
import { replayCorpus } from "./replay.js";
import { replayNightlyCorpus } from "./nightly-replay.js";
import { replayReleaseCorpus } from "./release-replay.js";
import {
  GROUNDED_POISON_CORPUS,
  GROUNDED_NIGHTLY_CORPUS,
  GROUNDED_RELEASE_CORPUS,
  groundedModel,
} from "./grounded.js";

/**
 * `npm run corpus:grounded` — replays the ONE grounded, real-defect-shaped change
 * (a fail-open ownership guard) through all three gates with a deterministic,
 * offline model wired in, and prints what each gate decides. This is the corpus
 * that exercises scruffy's SEMANTIC detection path (the model analyzer); the other
 * three corpus runs are deterministic-only by design.
 *
 * Exits non-zero on any regression, or if the release gate unsafely ships.
 */

const POISON_POLICY: PoisonPolicy = {
  blockableDefectClasses: [...POISON_BLOCKABLE_CLASSES],
  requireValidation: true,
};
const NIGHTLY_POLICY: NightlyPolicy = {
  reportableDefectClasses: [...NIGHTLY_REPORTABLE_CLASSES],
  fixableDefectClasses: [...NIGHTLY_FIXABLE_CLASSES],
};
const RELEASE_POLICY: ReleasePolicy = {
  stopDefectClasses: [...RELEASE_STOP_CLASSES],
  signoffDefectClasses: [...RELEASE_SIGNOFF_CLASSES],
};

async function main(): Promise<void> {
  // A fresh fake model per gate; each returns the same canned finding, anchored
  // to the grounded change only.
  const poison = await replayCorpus(GROUNDED_POISON_CORPUS, {
    analyzers: [...defaultAnalyzers(), ...modelAnalyzers(groundedModel())],
    validator: defaultValidator(),
    policy: POISON_POLICY,
  });
  const nightly = await replayNightlyCorpus(GROUNDED_NIGHTLY_CORPUS, {
    analyzers: [...defaultAnalyzers(), ...modelAnalyzers(groundedModel())],
    validator: defaultValidator(),
    fixers: defaultFixers(),
    policy: NIGHTLY_POLICY,
  });
  const release = await replayReleaseCorpus(GROUNDED_RELEASE_CORPUS, {
    analyzers: [...defaultAnalyzers(), ...modelAnalyzers(groundedModel())],
    validator: defaultValidator(),
    policy: RELEASE_POLICY,
  });

  const poisonCase = poison.cases[0]!;
  const nightlyCase = nightly.cases[0]!;
  const releaseCase = release.cases[0]!;

  console.log("Grounded replay — one real merged defect (fail-open ownership guard), scored by all three gates.");
  console.log("Grounding: seeded-mutation shape of a real merged defect (context-and/portfolio-simulation d745dcf); invented identifiers.\n");

  console.log("Per-gate outcome (defect class: missing-authorization, model-asserted):");
  console.log(`  poison   -> ${poisonCase.outcome.padEnd(18)} (out of blocking scope; no false-block)`);
  console.log(`  nightly  -> ${(nightlyCase.correct === 1 ? "report" : "MISHANDLED").padEnd(18)} (surfaced for a human; not auto-fixed)`);
  console.log(`  release  -> ${releaseCase.outcome.padEnd(18)} (human sign-off; no silent ship, no fabricated stop)`);

  console.log("\nSafety checks:");
  console.log(`  poison false-block      ${poison.confusion.false_block}`);
  console.log(`  nightly false-surface   ${nightly.totals.falseSurface}`);
  console.log(`  release unsafe ships    ${release.metrics.unsafeShips}`);

  const regressions = [
    ...poison.regressions.map((r) => ({ gate: "poison", ...r })),
    ...nightly.regressions.map((r) => ({ gate: "nightly", ...r })),
    ...release.regressions.map((r) => ({ gate: "release", ...r })),
  ];

  if (regressions.length > 0 || release.metrics.unsafeShips > 0) {
    console.log("\nFAIL:");
    for (const r of regressions) console.log(`  [${r.gate}] regression: ${JSON.stringify(r)}`);
    if (release.metrics.unsafeShips > 0) console.log(`  release unsafely shipped a possible auth bypass`);
    process.exitCode = 1;
  } else {
    console.log("\nNo regressions. Each gate handled the grounded defect per its role.");
  }
}

await main();
