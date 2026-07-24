import { describe, expect, it } from "vitest";
import {
  defaultAnalyzers,
  defaultValidator,
  defaultFixers,
  NIGHTLY_REPORTABLE_CLASSES,
  NIGHTLY_FIXABLE_CLASSES,
} from "../../src/providers/registry.js";
import { NightlyCorpus } from "../../src/corpus/nightly-types.js";
import { replayNightlyCorpus } from "../../src/corpus/nightly-replay.js";
import { SEEDED_NIGHTLY_CORPUS } from "../../src/corpus/nightly-corpus.js";
import type { NightlyPolicy } from "../../src/domain/policy/types.js";

const POLICY: NightlyPolicy = {
  reportableDefectClasses: [...NIGHTLY_REPORTABLE_CLASSES],
  fixableDefectClasses: [...NIGHTLY_FIXABLE_CLASSES],
};

const deps = { analyzers: defaultAnalyzers(), validator: defaultValidator(), fixers: defaultFixers(), policy: POLICY };

describe("nightly corpus replay (pure disposition + fix measurement)", () => {
  it("the seeded nightly corpus conforms to the schema", () => {
    expect(() => NightlyCorpus.parse(SEEDED_NIGHTLY_CORPUS)).not.toThrow();
  });

  it("scores the seeded corpus: right dispositions, a fix generated, nothing spurious", async () => {
    const r = await replayNightlyCorpus(SEEDED_NIGHTLY_CORPUS, deps);

    expect(r.total).toBe(4);
    expect(r.totals.missed).toBe(0);
    expect(r.totals.wrongDisposition).toBe(0);
    expect(r.totals.falseSurface).toBe(0);

    // mixed range: report (leaked-cred) + propose_fix (prod TLS); plus the
    // agent-harness secret range: report (leaked-cred). Three surfaced total —
    // the refuted-noise range suppresses both its findings and surfaces nothing.
    expect(r.totals.expectedSurfaced).toBe(3);
    expect(r.totals.actualSurfaced).toBe(3);
    // one fix expected (the prod TLS-disable), one generated.
    expect(r.totals.fixesExpected).toBe(1);
    expect(r.totals.fixesGenerated).toBe(1);

    expect(r.metrics.surfacePrecision).toBe(1);
    expect(r.metrics.surfaceRecall).toBe(1);
    expect(r.metrics.dispositionAccuracy).toBe(1);
    expect(r.metrics.fixGenerationRate).toBe(1);
    expect(r.regressions).toEqual([]);
  });

  it("the clean range surfaces nothing (no false report/propose_fix)", async () => {
    const r = await replayNightlyCorpus(SEEDED_NIGHTLY_CORPUS, deps);
    const clean = r.cases.find((c) => c.id === "nightly-clean-range")!;
    expect(clean.falseSurface).toBe(0);
    expect(clean.correct).toBe(0);
    expect(clean.summaryRegressed).toBe(false);
  });

  it("flags a regression when the disposition summary disagrees with the pin", async () => {
    const tampered = SEEDED_NIGHTLY_CORPUS.map((c) =>
      c.id === "nightly-mixed-review" ? { ...c, expectedSummary: { reported: 5, proposedFixes: 0, suppressed: 0 } } : c,
    );
    const r = await replayNightlyCorpus(tampered, deps);
    expect(r.regressions.map((x) => x.id)).toContain("nightly-mixed-review");
  });
});
