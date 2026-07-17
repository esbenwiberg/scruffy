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
import { SYNTHETIC_CORPUS } from "./synthetic.js";
import { SEEDED_CORPUS } from "./seeded.js";
import { SEEDED_NIGHTLY_CORPUS } from "./nightly-corpus.js";
import { SEEDED_RELEASE_CORPUS } from "./release-corpus.js";
import {
  GROUNDED_POISON_CORPUS,
  GROUNDED_NIGHTLY_CORPUS,
  GROUNDED_RELEASE_CORPUS,
  groundedModel,
} from "./grounded.js";

/**
 * `npm run corpus:all` — the single cross-gate sweep. Runs EVERY corpus through
 * its gate and prints one compact line per (gate, corpus), then an overall
 * verdict. Two lanes per gate:
 *   - deterministic: synthetic + seeded cases through `defaultAnalyzers()`.
 *   - grounded: real-defect-shaped cases through the model-backed analyzers
 *     (deterministic + an offline fake model), the semantic lane.
 * The individual `corpus`, `corpus:nightly`, `corpus:release`, `corpus:grounded`
 * scripts still exist for the full per-gate confusion matrices; this is the
 * one-command "is everything green across all gates and all seed data" check.
 *
 * Exits non-zero on ANY regression, any false-block, or any unsafe release ship.
 */

const POISON_POLICY: PoisonPolicy = { blockableDefectClasses: [...POISON_BLOCKABLE_CLASSES], requireValidation: true };
const NIGHTLY_POLICY: NightlyPolicy = {
  reportableDefectClasses: [...NIGHTLY_REPORTABLE_CLASSES],
  fixableDefectClasses: [...NIGHTLY_FIXABLE_CLASSES],
};
const RELEASE_POLICY: ReleasePolicy = { stopDefectClasses: [...RELEASE_STOP_CLASSES], signoffDefectClasses: [...RELEASE_SIGNOFF_CLASSES] };

const det = () => ({ analyzers: defaultAnalyzers(), validator: defaultValidator() });
const modelBacked = () => ({ analyzers: [...defaultAnalyzers(), ...modelAnalyzers(groundedModel())], validator: defaultValidator() });

function pct(n: number | null): string {
  return n === null ? "n/a" : `${(n * 100).toFixed(1)}%`;
}

interface Line {
  gate: string;
  lane: string;
  detail: string;
  ok: boolean;
}

async function main(): Promise<void> {
  const lines: Line[] = [];
  let failures = 0;

  // ── Poison ────────────────────────────────────────────────────────────────
  const poisonDet = await replayCorpus([...SYNTHETIC_CORPUS, ...SEEDED_CORPUS], { ...det(), policy: POISON_POLICY });
  const poisonGrounded = await replayCorpus(GROUNDED_POISON_CORPUS, { ...modelBacked(), policy: POISON_POLICY });
  for (const [lane, r] of [["deterministic", poisonDet], ["grounded", poisonGrounded]] as const) {
    const ok = r.confusion.false_block === 0 && r.regressions.length === 0;
    if (!ok) failures += 1;
    lines.push({
      gate: "poison",
      lane,
      detail: `${r.total} cases, block precision ${pct(r.metrics.blockPrecision)}, false-block ${r.confusion.false_block}, regressions ${r.regressions.length}`,
      ok,
    });
  }

  // ── Nightly ─────────────────────────────────────────────────────────────────
  const nightlyDet = await replayNightlyCorpus(SEEDED_NIGHTLY_CORPUS, { ...det(), fixers: defaultFixers(), policy: NIGHTLY_POLICY });
  const nightlyGrounded = await replayNightlyCorpus(GROUNDED_NIGHTLY_CORPUS, { ...modelBacked(), fixers: defaultFixers(), policy: NIGHTLY_POLICY });
  for (const [lane, r] of [["deterministic", nightlyDet], ["grounded", nightlyGrounded]] as const) {
    const ok = r.totals.falseSurface === 0 && r.regressions.length === 0;
    if (!ok) failures += 1;
    lines.push({
      gate: "nightly",
      lane,
      detail: `${r.total} ranges, disposition acc ${pct(r.metrics.dispositionAccuracy)}, false-surface ${r.totals.falseSurface}, regressions ${r.regressions.length}`,
      ok,
    });
  }

  // ── Release ─────────────────────────────────────────────────────────────────
  const releaseDet = await replayReleaseCorpus(SEEDED_RELEASE_CORPUS, { ...det(), policy: RELEASE_POLICY });
  const releaseGrounded = await replayReleaseCorpus(GROUNDED_RELEASE_CORPUS, { ...modelBacked(), policy: RELEASE_POLICY });
  for (const [lane, r] of [["deterministic", releaseDet], ["grounded", releaseGrounded]] as const) {
    const ok = r.metrics.unsafeShips === 0 && r.regressions.length === 0;
    if (!ok) failures += 1;
    lines.push({
      gate: "release",
      lane,
      detail: `${r.total} ranges, outcome acc ${pct(r.metrics.outcomeAccuracy)}, unsafe ships ${r.metrics.unsafeShips}, regressions ${r.regressions.length}`,
      ok,
    });
  }

  console.log("Cross-gate corpus sweep — every corpus through its gate (deterministic + grounded lanes).\n");
  for (const l of lines) {
    console.log(`  ${l.ok ? "PASS" : "FAIL"}  ${l.gate.padEnd(8)} ${l.lane.padEnd(14)} ${l.detail}`);
  }

  if (failures > 0) {
    console.log(`\nOVERALL: FAIL (${failures} lane(s) with a false-block, unsafe ship, or regression)`);
    process.exitCode = 1;
  } else {
    console.log("\nOVERALL: PASS — no false-blocks, no unsafe ships, no regressions across any gate.");
  }
}

await main();
