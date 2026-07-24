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
import { pathToFileURL } from "node:url";
import { replayCorpus, type ReplayReport } from "./replay.js";
import { replayNightlyCorpus, type NightlyReplayReport } from "./nightly-replay.js";
import { replayReleaseCorpus, type ReleaseReplayReport } from "./release-replay.js";
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

/** A nightly case is "MISHANDLED" unless it matched its one expected finding and surfaced nothing benign. */
export function nightlyOutcomeLabel(n: { correct: number; falseSurface: number }): "report" | "MISHANDLED" {
  return n.correct === 1 && n.falseSurface === 0 ? "report" : "MISHANDLED";
}

/**
 * Per-case report block. The parenthetical is DERIVED from the actual outcome, so
 * a regressed gate never prints a reassuring "no false-block" claim next to a
 * contradicting outcome (the summary is this script's primary artifact).
 */
export function formatGroundedCase(
  id: string,
  sourceRepo: string | undefined,
  sourceRef: string | undefined,
  poisonOutcome: ReplayReport["cases"][number]["outcome"],
  nightly: { correct: number; falseSurface: number },
  releaseOutcome: ReleaseReplayReport["cases"][number]["outcome"],
): string {
  const nightlyLabel = nightlyOutcomeLabel(nightly);
  const poisonNote =
    poisonOutcome === "allow" ? "out of blocking scope; no false-block" : "UNEXPECTED — poison must ALLOW here; see FAIL";
  const nightlyNote =
    nightlyLabel === "report" ? "surfaced for a human; not auto-fixed" : "UNEXPECTED — not surfaced cleanly; see FAIL";
  const releaseNote =
    releaseOutcome === "sign-off-required"
      ? "human sign-off; no silent ship, no fabricated stop"
      : "UNEXPECTED — release must force SIGN-OFF here; see FAIL";
  return [
    `${id}  (${sourceRepo ?? "?"} ${(sourceRef ?? "").split(" ")[0]})`,
    `  poison   -> ${poisonOutcome.padEnd(18)} (${poisonNote})`,
    `  nightly  -> ${nightlyLabel.padEnd(18)} (${nightlyNote})`,
    `  release  -> ${releaseOutcome.padEnd(18)} (${releaseNote})`,
  ].join("\n");
}

export interface GroundedGateDecision {
  regressions: { gate: string; id: string; expected: string; actual: string; field?: string }[];
  poisonFalseBlock: number;
  nightlyFalseSurface: number;
  releaseUnsafeShips: number;
  mishandledNightly: string[];
  failed: boolean;
}

/**
 * Pure pass/fail decision for the grounded sweep. Fails on any regression or unsafe
 * release ship AND — matching the printed "Safety checks" header and the sibling
 * all-run.ts sweep — on any poison false-block or nightly false-surface. It also
 * fails on any nightly case that is MISHANDLED (correct !== 1 || falseSurface !== 0)
 * even when no summary regression was recorded, so the gate no longer relies on the
 * incidental coupling between a mishandled case and a summary-pin mismatch.
 */
export function decideGrounded(
  poison: ReplayReport,
  nightly: NightlyReplayReport,
  release: ReleaseReplayReport,
): GroundedGateDecision {
  const regressions = [
    ...poison.regressions.map((r) => ({ gate: "poison", ...r })),
    ...nightly.regressions.map((r) => ({ gate: "nightly", ...r })),
    ...release.regressions.map((r) => ({ gate: "release", ...r })),
  ];
  const mishandledNightly = nightly.cases.filter((n) => nightlyOutcomeLabel(n) === "MISHANDLED").map((n) => n.id);
  const failed =
    regressions.length > 0 ||
    release.metrics.unsafeShips > 0 ||
    poison.confusion.false_block > 0 ||
    nightly.totals.falseSurface > 0 ||
    mishandledNightly.length > 0;
  return {
    regressions,
    poisonFalseBlock: poison.confusion.false_block,
    nightlyFalseSurface: nightly.totals.falseSurface,
    releaseUnsafeShips: release.metrics.unsafeShips,
    mishandledNightly,
    failed,
  };
}

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
    console.log(formatGroundedCase(c.id, c.provenance.sourceRepo, c.provenance.sourceRef, p.outcome, n, r.outcome) + "\n");
  }

  console.log("Safety checks:");
  console.log(`  poison false-block      ${poison.confusion.false_block}`);
  console.log(`  nightly false-surface   ${nightly.totals.falseSurface}`);
  console.log(`  release unsafe ships    ${release.metrics.unsafeShips}`);

  const decision = decideGrounded(poison, nightly, release);

  if (decision.failed) {
    console.log("\nFAIL:");
    for (const r of decision.regressions) console.log(`  [${r.gate}] regression: ${JSON.stringify(r)}`);
    if (decision.releaseUnsafeShips > 0) console.log(`  release unsafely shipped a possible regression`);
    if (decision.poisonFalseBlock > 0) console.log(`  poison false-blocked a benign change (${decision.poisonFalseBlock})`);
    if (decision.nightlyFalseSurface > 0) console.log(`  nightly false-surfaced a benign change (${decision.nightlyFalseSurface})`);
    if (decision.mishandledNightly.length > 0) console.log(`  nightly MISHANDLED: ${decision.mishandledNightly.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("\nNo regressions. Every gate handled every grounded defect per its role.");
  }
}

// Only run when invoked as a script (`npm run corpus:grounded`); importing this
// module for its pure helpers (e.g. in tests) must not execute the sweep.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
