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
 * `npm run corpus:grounded` — replays every grounded, real-defect-shaped change
 * through all three gates with a deterministic, offline model wired in, and prints
 * what each gate decides per case. This is the corpus that exercises scruffy's
 * SEMANTIC detection path (the model analyzer); the other corpus runs are
 * deterministic-only by design.
 *
 * Exits non-zero on any regression, or if the release gate unsafely ships.
 */

const POISON_POLICY: PoisonPolicy = { blockableDefectClasses: [...POISON_BLOCKABLE_CLASSES], requireValidation: true };
const NIGHTLY_POLICY: NightlyPolicy = {
  reportableDefectClasses: [...NIGHTLY_REPORTABLE_CLASSES],
  fixableDefectClasses: [...NIGHTLY_FIXABLE_CLASSES],
};
const RELEASE_POLICY: ReleasePolicy = { stopDefectClasses: [...RELEASE_STOP_CLASSES], signoffDefectClasses: [...RELEASE_SIGNOFF_CLASSES] };

async function main(): Promise<void> {
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

  const poisonById = new Map(poison.cases.map((c) => [c.id, c]));
  const nightlyById = new Map(nightly.cases.map((c) => [c.id, c]));
  const releaseById = new Map(release.cases.map((c) => [c.id, c]));

  console.log(`Grounded replay — ${GROUNDED_POISON_CORPUS.length} real merged defect(s), each scored by all three gates.`);
  console.log("Grounding: seeded-mutation shapes of real merged defects (context-and repos); invented identifiers, no real bytes.\n");

  for (const c of GROUNDED_POISON_CORPUS) {
    const p = poisonById.get(c.id)!;
    const n = nightlyById.get(c.id)!;
    const r = releaseById.get(c.id)!;
    const nightlyOutcome = n.correct === 1 && n.falseSurface === 0 ? "report" : "MISHANDLED";
    console.log(`${c.id}  (${c.provenance.sourceRepo} ${(c.provenance.sourceRef ?? "").split(" ")[0]})`);
    console.log(`  poison   -> ${p.outcome.padEnd(18)} (out of blocking scope; no false-block)`);
    console.log(`  nightly  -> ${nightlyOutcome.padEnd(18)} (surfaced for a human; not auto-fixed)`);
    console.log(`  release  -> ${r.outcome.padEnd(18)} (human sign-off; no silent ship, no fabricated stop)\n`);
  }

  console.log("Safety checks:");
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
    if (release.metrics.unsafeShips > 0) console.log(`  release unsafely shipped a possible regression`);
    process.exitCode = 1;
  } else {
    console.log("\nNo regressions. Every gate handled every grounded defect per its role.");
  }
}

await main();
