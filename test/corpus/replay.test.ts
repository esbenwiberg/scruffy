import { describe, expect, it } from "vitest";
import { defaultAnalyzers, defaultValidator, POISON_BLOCKABLE_CLASSES } from "../../src/providers/registry.js";
import { Corpus } from "../../src/corpus/types.js";
import { replayCorpus } from "../../src/corpus/replay.js";
import { SYNTHETIC_CORPUS } from "../../src/corpus/synthetic.js";
import type { PoisonPolicy } from "../../src/domain/policy/types.js";

const POLICY: PoisonPolicy = { blockableDefectClasses: [...POISON_BLOCKABLE_CLASSES], requireValidation: true };

const deps = { analyzers: defaultAnalyzers(), validator: defaultValidator(), policy: POLICY };

describe("corpus replay (no database, pure measurement)", () => {
  it("the synthetic corpus conforms to the labeled-case schema", () => {
    expect(() => Corpus.parse(SYNTHETIC_CORPUS)).not.toThrow();
  });

  it("scores the synthetic corpus: zero false blocks across three defect classes", async () => {
    const r = await replayCorpus(SYNTHETIC_CORPUS, deps);

    expect(r.total).toBe(16);
    expect(r.positives).toBe(9);
    expect(r.negatives).toBe(7);

    expect(r.confusion.true_block).toBe(8);
    expect(r.confusion.false_block).toBe(0);
    expect(r.confusion.missed).toBe(0);
    expect(r.confusion.true_allow).toBe(7);
    expect(r.confusion.abstain_on_poison).toBe(1); // the DROP TABLE escalation
    expect(r.confusion.abstain_on_clean).toBe(0);

    expect(r.metrics.blockPrecision).toBe(1);
    expect(r.metrics.falseBlockRate).toBe(0);
    expect(r.metrics.severeRecall).toBeCloseTo(8 / 9, 5);
    expect(r.metrics.abstainRate).toBeCloseTo(1 / 16, 5);

    expect(r.byDefectClass["leaked-credential"]).toEqual({ positives: 3, caught: 3, missed: 0, abstained: 0 });
    expect(r.byDefectClass["destructive-schema-change"]).toEqual({ positives: 3, caught: 2, missed: 0, abstained: 1 });
    expect(r.byDefectClass["disabled-tls-verification"]).toEqual({ positives: 3, caught: 3, missed: 0, abstained: 0 });
    expect(r.regressions).toEqual([]);
  });

  it("computes a Wilson lower bound below the point estimate", async () => {
    const r = await replayCorpus(SYNTHETIC_CORPUS, deps);
    // 3/3 blocks correct -> precision 1.0, but small-n lower bound is well below 1.
    expect(r.metrics.blockPrecisionWilsonLower95).not.toBeNull();
    expect(r.metrics.blockPrecisionWilsonLower95!).toBeLessThan(1);
    expect(r.metrics.blockPrecisionWilsonLower95!).toBeGreaterThan(0.3);
  });

  it("flags a regression when the gate disagrees with a case's expectedOutcome", async () => {
    // Mislabel the AWS-key case's expectation to prove the regression detector fires.
    const tampered = SYNTHETIC_CORPUS.map((c) =>
      c.id === "leak-aws-key" ? { ...c, expectedOutcome: "allow" as const } : c,
    );
    const r = await replayCorpus(tampered, deps);
    expect(r.regressions).toEqual([{ id: "leak-aws-key", expected: "allow", actual: "block" }]);
  });
});
