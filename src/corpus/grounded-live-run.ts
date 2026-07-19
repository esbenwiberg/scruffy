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
import type { ModelProvider, ModelRequest, ModelResponse } from "../providers/models/port.js";
import { createModelProvider, resolveBackend, type ModelBackend } from "../providers/models/factory.js";
import { ModelAnalyzer } from "../providers/analyzers/model-analyzer.js";
import type { Finding } from "../domain/evidence/types.js";
import { replayCorpus } from "./replay.js";
import { replayNightlyCorpus } from "./nightly-replay.js";
import { replayReleaseCorpus } from "./release-replay.js";
import type { NightlyCase } from "./nightly-types.js";
import {
  GROUNDED_SPECS,
  GROUNDED_POISON_CORPUS,
  GROUNDED_NIGHTLY_CORPUS,
  GROUNDED_RELEASE_CORPUS,
} from "./grounded.js";

/**
 * `npm run corpus:grounded:live` — the grounded corpus against a REAL model.
 *
 * `corpus:grounded` proves the plumbing with a fake model that is handed the
 * exact answer. This run tests the thesis itself ("an LLM widens detection"):
 * does a real model, given only the added lines, independently find each
 * grounded defect? Two phases:
 *
 *  1. Model-analyzer recall: per case, compare what the model actually found
 *     against the seeded ground truth (match key: defect class + path; the
 *     seed's line is reported but not required — any real anchored line on the
 *     defective file counts).
 *  2. Three-gate replay with the same model wired in, checking the gates land
 *     where the corpus says they must (poison allow, nightly report, release
 *     sign-off). Model responses are memoized, so the whole run costs ONE model
 *     call per case.
 *
 * A live model is non-deterministic, so this is a manually-run probe, not a CI
 * gate. The nightly exact-count summary pins are dropped for this run (an extra
 * true-ish finding shouldn't fail the probe); extra findings are reported so
 * precision is visible. Exit is non-zero when the thesis fails: a seeded defect
 * missed, a poison false-block, an unsafe release ship, or a gate-outcome
 * regression.
 *
 * Backend: defaults to `claude-cli` (this is a live run — the fake is refused);
 * override with SCRUFFY_MODEL_BACKEND=anthropic|azure, and pin the CLI model
 * with SCRUFFY_CLAUDE_CLI_MODEL.
 */

/** Memoizes by full request so poison/nightly/release replays reuse the phase-1
 * call — identical files build an identical prompt. Also records each fresh
 * call's raw text so a zero-finding case can show what the model actually said. */
class MemoizedModelProvider implements ModelProvider {
  readonly id: string;
  readonly calls: { request: ModelRequest; text: string }[] = [];
  readonly #inner: ModelProvider;
  readonly #cache = new Map<string, Promise<ModelResponse>>();

  constructor(inner: ModelProvider) {
    this.#inner = inner;
    this.id = inner.id;
  }

  complete(request: ModelRequest): Promise<ModelResponse> {
    const key = `${request.promptVersion}\0${request.system}\0${request.input}`;
    let pending = this.#cache.get(key);
    if (!pending) {
      pending = this.#inner.complete(request).then((response) => {
        this.calls.push({ request, text: response.text });
        return response;
      });
      this.#cache.set(key, pending);
    }
    return pending;
  }
}

const POISON_POLICY: PoisonPolicy = { blockableDefectClasses: [...POISON_BLOCKABLE_CLASSES], requireValidation: true };
const NIGHTLY_POLICY: NightlyPolicy = {
  reportableDefectClasses: [...NIGHTLY_REPORTABLE_CLASSES],
  fixableDefectClasses: [...NIGHTLY_FIXABLE_CLASSES],
};
const RELEASE_POLICY: ReleasePolicy = { stopDefectClasses: [...RELEASE_STOP_CLASSES], signoffDefectClasses: [...RELEASE_SIGNOFF_CLASSES] };

function resolveLiveBackend(): ModelBackend {
  const backend = process.env.SCRUFFY_MODEL_BACKEND === undefined ? "claude-cli" : resolveBackend();
  if (backend === "fake") {
    console.error(
      "corpus:grounded:live refuses the fake backend — its whole point is a real model.\n" +
        "Unset SCRUFFY_MODEL_BACKEND (defaults to claude-cli) or set it to anthropic|azure.\n" +
        "For the deterministic run, use `npm run corpus:grounded`.",
    );
    process.exit(2);
  }
  return backend;
}

/** Live nightly corpus: same cases minus the exact-count summary pins. */
function withoutSummaryPins(corpus: readonly NightlyCase[]): NightlyCase[] {
  return corpus.map((c) => {
    const { expectedSummary: _dropped, ...rest } = c;
    return rest;
  });
}

async function main(): Promise<void> {
  const backend = resolveLiveBackend();
  const model = new MemoizedModelProvider(await createModelProvider(backend));
  console.log(`Grounded LIVE replay — real model, no seeded answers. backend=${backend} provider=${model.id}\n`);

  // ── Phase 1: does the real model find each grounded defect on its own? ──────
  const analyzer = new ModelAnalyzer(model);
  const subjectById = new Map(GROUNDED_POISON_CORPUS.map((c) => [c.id, c.subject]));
  let missed = 0;
  let extras = 0;

  console.log("Phase 1 — model-analyzer recall vs seeded ground truth:\n");
  for (const spec of GROUNDED_SPECS) {
    const callsBefore = model.calls.length;
    const findings: Finding[] = await analyzer.analyze(subjectById.get(spec.id)!, spec.files);
    const benignPaths = new Set(spec.files.map((f) => f.path).filter((p) => p !== spec.modelSeed.path));

    console.log(`${spec.id}`);
    console.log(`  seed:  ${spec.modelSeed.class} @ ${spec.modelSeed.path}:${spec.modelSeed.line}`);

    const hits = findings.filter((f) => f.defectClass === spec.modelSeed.class && f.primaryRegion.path === spec.modelSeed.path);
    const rest = findings.filter((f) => !hits.includes(f));

    for (const f of findings) {
      const loc = `${f.primaryRegion.path}:${f.primaryRegion.startLine}`;
      const mark = hits.includes(f) ? "hit  " : benignPaths.has(f.primaryRegion.path) ? "NOISE" : "extra";
      console.log(`  ${mark}: ${f.defectClass} @ ${loc}`);
      console.log(`         ${f.supporting[0]?.statement ?? "(no statement)"}`);
    }

    if (hits.length === 0) {
      missed += 1;
      console.log("  -> MISSED — the model did not find the seeded defect.");
      const call = model.calls.length > callsBefore ? model.calls[model.calls.length - 1] : undefined;
      if (findings.length === 0 && call) {
        console.log(`  raw model output (for diagnosis): ${call.text.slice(0, 500)}`);
      }
    } else {
      const lineNote = hits.some((f) => f.primaryRegion.startLine === spec.modelSeed.line)
        ? "line matches the seed"
        : `anchored to line ${hits[0]!.primaryRegion.startLine}, seed says ${spec.modelSeed.line}`;
      console.log(`  -> CAUGHT (${lineNote})`);
    }
    extras += rest.length;
    console.log();
  }

  // ── Phase 2: the three gates with the real model wired in (cached calls). ───
  console.log("Phase 2 — three-gate replay with the real model (memoized; no extra model calls):\n");
  const liveAnalyzers = [...defaultAnalyzers(), ...modelAnalyzers(model)];
  const poison = await replayCorpus(GROUNDED_POISON_CORPUS, {
    analyzers: liveAnalyzers,
    validator: defaultValidator(),
    policy: POISON_POLICY,
  });
  const nightly = await replayNightlyCorpus(withoutSummaryPins(GROUNDED_NIGHTLY_CORPUS), {
    analyzers: liveAnalyzers,
    validator: defaultValidator(),
    fixers: defaultFixers(),
    policy: NIGHTLY_POLICY,
  });
  const release = await replayReleaseCorpus(GROUNDED_RELEASE_CORPUS, {
    analyzers: liveAnalyzers,
    validator: defaultValidator(),
    policy: RELEASE_POLICY,
  });

  const poisonById = new Map(poison.cases.map((c) => [c.id, c]));
  const nightlyById = new Map(nightly.cases.map((c) => [c.id, c]));
  const releaseById = new Map(release.cases.map((c) => [c.id, c]));

  for (const spec of GROUNDED_SPECS) {
    const p = poisonById.get(spec.id)!;
    const n = nightlyById.get(spec.id)!;
    const r = releaseById.get(spec.id)!;
    const nightlyOutcome = n.missed === 0 ? "report" : "MISSED";
    const noise = n.falseSurface > 0 ? ` (+${n.falseSurface} unexpected surface)` : "";
    console.log(`${spec.id}`);
    console.log(`  poison   -> ${p.outcome.padEnd(18)} (must not false-block)`);
    console.log(`  nightly  -> ${nightlyOutcome.padEnd(18)} (surfaced for a human)${noise}`);
    console.log(`  release  -> ${r.outcome.padEnd(18)} (human sign-off; no silent ship)\n`);
  }

  console.log("Safety checks:");
  console.log(`  poison false-block      ${poison.confusion.false_block}`);
  console.log(`  nightly missed          ${nightly.totals.missed}`);
  console.log(`  nightly false-surface   ${nightly.totals.falseSurface}  (reported, not failing)`);
  console.log(`  release unsafe ships    ${release.metrics.unsafeShips}`);
  console.log(`  live model calls        ${model.calls.length}`);

  const regressions = [
    ...poison.regressions.map((r) => ({ gate: "poison", ...r })),
    ...release.regressions.map((r) => ({ gate: "release", ...r })),
  ];

  const failed = missed > 0 || poison.confusion.false_block > 0 || release.metrics.unsafeShips > 0 || regressions.length > 0;
  if (failed) {
    console.log("\nFAIL — the real model did not sustain the grounded thesis:");
    if (missed > 0) console.log(`  ${missed} seeded defect(s) not found by the model`);
    if (poison.confusion.false_block > 0) console.log(`  poison false-blocked a clean change`);
    if (release.metrics.unsafeShips > 0) console.log(`  release unsafely shipped a possible regression`);
    for (const r of regressions) console.log(`  [${r.gate}] regression: ${JSON.stringify(r)}`);
    process.exitCode = 1;
  } else {
    const extraNote = extras > 0 ? ` (${extras} extra finding(s) beyond the seeds — see phase 1)` : "";
    console.log(`\nPASS — the real model found every grounded defect and every gate held its posture${extraNote}.`);
  }
}

await main();
