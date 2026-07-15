import { describe, expect, it } from "vitest";
import { SecretScanAnalyzer } from "../../src/providers/analyzers/secret-scan.js";
import { SecretValidator } from "../../src/providers/validation/secret-validator.js";
import { Corpus } from "../../src/corpus/types.js";
import { replayCorpus } from "../../src/corpus/replay.js";
import { SYNTHETIC_CORPUS } from "../../src/corpus/synthetic.js";
import type { PoisonPolicy } from "../../src/domain/policy/types.js";

const POLICY: PoisonPolicy = { blockableDefectClasses: ["leaked-credential"], requireValidation: true };

const deps = { analyzers: [new SecretScanAnalyzer()], validator: new SecretValidator(), policy: POLICY };

describe("corpus replay (no database, pure measurement)", () => {
  it("the synthetic corpus conforms to the labeled-case schema", () => {
    expect(() => Corpus.parse(SYNTHETIC_CORPUS)).not.toThrow();
  });

  it("scores the synthetic corpus with zero false blocks and full recall", async () => {
    const r = await replayCorpus(SYNTHETIC_CORPUS, deps);

    expect(r.total).toBe(7);
    expect(r.positives).toBe(3);
    expect(r.negatives).toBe(4);

    expect(r.confusion.true_block).toBe(3);
    expect(r.confusion.false_block).toBe(0);
    expect(r.confusion.missed).toBe(0);
    expect(r.confusion.true_allow).toBe(4);

    expect(r.metrics.blockPrecision).toBe(1);
    expect(r.metrics.falseBlockRate).toBe(0);
    expect(r.metrics.severeRecall).toBe(1);
    expect(r.metrics.abstainRate).toBe(0);

    expect(r.byDefectClass["leaked-credential"]).toEqual({ positives: 3, caught: 3, missed: 0, abstained: 0 });
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
