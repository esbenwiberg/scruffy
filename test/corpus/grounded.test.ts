import { describe, expect, it } from "vitest";
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
} from "../../src/providers/registry.js";
import { Corpus } from "../../src/corpus/types.js";
import { NightlyCorpus } from "../../src/corpus/nightly-types.js";
import { ReleaseCorpus } from "../../src/corpus/release-types.js";
import { replayCorpus } from "../../src/corpus/replay.js";
import { replayNightlyCorpus } from "../../src/corpus/nightly-replay.js";
import { replayReleaseCorpus } from "../../src/corpus/release-replay.js";
import {
  GROUNDED_POISON_CORPUS,
  GROUNDED_NIGHTLY_CORPUS,
  GROUNDED_RELEASE_CORPUS,
  groundedModel,
} from "../../src/corpus/grounded.js";
import type { PoisonPolicy, NightlyPolicy, ReleasePolicy } from "../../src/domain/policy/types.js";

/**
 * The grounded corpus is a single real merged defect (a fail-open ownership
 * guard = missing-authorization) reproduced from scratch and scored by all three
 * gates with a deterministic, offline model wired in. These tests pin that each
 * gate does its own job on the ONE change, and that the model finding never leaks
 * beyond the line it anchors to.
 */

const POISON_POLICY: PoisonPolicy = { blockableDefectClasses: [...POISON_BLOCKABLE_CLASSES], requireValidation: true };
const NIGHTLY_POLICY: NightlyPolicy = {
  reportableDefectClasses: [...NIGHTLY_REPORTABLE_CLASSES],
  fixableDefectClasses: [...NIGHTLY_FIXABLE_CLASSES],
};
const RELEASE_POLICY: ReleasePolicy = { stopDefectClasses: [...RELEASE_STOP_CLASSES], signoffDefectClasses: [...RELEASE_SIGNOFF_CLASSES] };

// Model-backed deps: the grounded case is a SEMANTIC defect, invisible to the
// deterministic analyzers, so the model analyzer must be wired in.
const withModel = () => [...defaultAnalyzers(), ...modelAnalyzers(groundedModel())];

describe("grounded corpus (real merged defect, model-backed, all three gates)", () => {
  it("conforms to every gate's schema and records auditable grounding provenance", () => {
    expect(() => Corpus.parse(GROUNDED_POISON_CORPUS)).not.toThrow();
    expect(() => NightlyCorpus.parse(GROUNDED_NIGHTLY_CORPUS)).not.toThrow();
    expect(() => ReleaseCorpus.parse(GROUNDED_RELEASE_CORPUS)).not.toThrow();

    const prov = GROUNDED_RELEASE_CORPUS[0]!.provenance;
    // Rebuilt from scratch (seeded-mutation), but grounded in a real merged defect
    // whose lineage is auditable — and NO real bytes cross over into this public repo.
    expect(prov.source).toBe("seeded-mutation");
    expect(prov.grounding).toBe("real-merged-defect");
    expect(prov.sourceRepo).toBeTruthy();
    expect(prov.sourceRef).toBeTruthy();
  });

  it("poison ALLOWS the semantic bypass (out of blocking scope) without false-blocking", async () => {
    const r = await replayCorpus(GROUNDED_POISON_CORPUS, { analyzers: withModel(), validator: defaultValidator(), policy: POISON_POLICY });
    expect(r.cases[0]!.outcome).toBe("allow");
    expect(r.confusion.false_block).toBe(0);
    expect(r.regressions).toEqual([]);
  });

  it("nightly REPORTS the bypass — model-asserted, not a fixable class, so no fix PR", async () => {
    const r = await replayNightlyCorpus(GROUNDED_NIGHTLY_CORPUS, {
      analyzers: withModel(),
      validator: defaultValidator(),
      fixers: defaultFixers(),
      policy: NIGHTLY_POLICY,
    });
    const c = r.cases[0]!;
    expect(c.correct).toBe(1); // the expected `report` was matched
    expect(c.missed).toBe(0);
    expect(c.falseSurface).toBe(0); // the benign formatter surfaced nothing
    expect(c.fixesGenerated).toBe(0);
    expect(r.regressions).toEqual([]);
  });

  it("release forces SIGN-OFF — never a silent ship, never a fabricated stop", async () => {
    const r = await replayReleaseCorpus(GROUNDED_RELEASE_CORPUS, { analyzers: withModel(), validator: defaultValidator(), policy: RELEASE_POLICY });
    expect(r.cases[0]!.outcome).toBe("sign-off-required");
    expect(r.metrics.unsafeShips).toBe(0);
    expect(r.regressions).toEqual([]);
  });

  it("without a model the semantic defect is invisible — release would UNSAFELY ship (why the model path exists)", async () => {
    // The deterministic analyzers alone cannot see a fail-open ownership guard.
    // This pins the exact gap the model analyzer closes: no model -> no finding ->
    // the last gate ships a possible auth bypass. The regression pin above is what
    // keeps that from being the real behavior.
    const r = await replayReleaseCorpus(GROUNDED_RELEASE_CORPUS, {
      analyzers: defaultAnalyzers(),
      validator: defaultValidator(),
      policy: RELEASE_POLICY,
    });
    expect(r.cases[0]!.outcome).toBe("ship");
    expect(r.metrics.unsafeShips).toBe(1);
  });

  it("the model finding anchors to the real defect line only — it does not spill onto the benign file", async () => {
    // Same fake model, a change with the SAME benign formatter but no guard file:
    // the canned finding must not anchor anywhere, so nothing is surfaced.
    const benignOnly = [GROUNDED_NIGHTLY_CORPUS[0]!].map((c) => ({
      ...c,
      id: "grounded-benign-only",
      files: c.files.filter((f) => f.path === "src/workspace/format.ts"),
      expected: [],
      expectedSummary: { reported: 0, proposedFixes: 0, suppressed: 0 },
    }));
    const r = await replayNightlyCorpus(benignOnly, {
      analyzers: withModel(),
      validator: defaultValidator(),
      fixers: defaultFixers(),
      policy: NIGHTLY_POLICY,
    });
    expect(r.totals.actualSurfaced).toBe(0);
    expect(r.regressions).toEqual([]);
  });
});
