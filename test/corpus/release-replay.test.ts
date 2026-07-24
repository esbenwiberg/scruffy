import { describe, expect, it } from "vitest";
import { defaultAnalyzers, defaultValidator, RELEASE_STOP_CLASSES, RELEASE_SIGNOFF_CLASSES } from "../../src/providers/registry.js";
import { ReleaseCorpus } from "../../src/corpus/release-types.js";
import { replayReleaseCorpus } from "../../src/corpus/release-replay.js";
import { summarizeRelease } from "../../src/corpus/release-run.js";
import { SEEDED_RELEASE_CORPUS } from "../../src/corpus/release-corpus.js";
import type { ReleasePolicy } from "../../src/domain/policy/types.js";

const POLICY: ReleasePolicy = {
  stopDefectClasses: [...RELEASE_STOP_CLASSES],
  signoffDefectClasses: [...RELEASE_SIGNOFF_CLASSES],
};

const deps = { analyzers: defaultAnalyzers(), validator: defaultValidator(), policy: POLICY };

describe("release corpus replay (pure aggregate-outcome measurement)", () => {
  it("the seeded release corpus conforms to the schema", () => {
    expect(() => ReleaseCorpus.parse(SEEDED_RELEASE_CORPUS)).not.toThrow();
  });

  it("reaches the right outcome for every seeded range, and never unsafely ships", async () => {
    const r = await replayReleaseCorpus(SEEDED_RELEASE_CORPUS, deps);

    expect(r.total).toBe(7);
    expect(r.metrics.outcomeAccuracy).toBe(1);
    expect(r.metrics.unsafeShips).toBe(0);
    expect(r.metrics.indeterminates).toBe(0);
    expect(r.regressions).toEqual([]);
  });

  it("stops the leaked-credential range and escalates (not stops) the unconfirmed DROP TABLE", async () => {
    const r = await replayReleaseCorpus(SEEDED_RELEASE_CORPUS, deps);
    const byId = new Map(r.cases.map((c) => [c.id, c]));

    expect(byId.get("release-stop-secret")!.outcome).toBe("stop");
    // A stop-CLASS defect the validator cannot confirm must escalate to a human,
    // never fabricate a stop.
    expect(byId.get("release-signoff-unconfirmed-drop")!.outcome).toBe("sign-off-required");
    expect(byId.get("release-signoff-tls")!.outcome).toBe("sign-off-required");
    expect(byId.get("release-ship-clean")!.outcome).toBe("ship");
    // Agent-harness-grounded: shipping a hardcoded key stops the release,
    // mirroring the harness's outbound push checkpoint blocking on secrets.
    expect(byId.get("release-harness-secret-stop")!.outcome).toBe("stop");
  });

  it("counts an unsafe ship when a stop range is mislabeled shippable", async () => {
    // Sanity-check the unsafeShip instrument: relabel the clean range's truth as
    // stop while its gate output stays ship, producing a (truth=stop, actual=ship)
    // case — THE dangerous error. This exercises unsafeShips, NOT over-caution
    // (over-caution is truth=ship / actual=stop; see the over-caution test below).
    const tampered = SEEDED_RELEASE_CORPUS.map((c) =>
      c.id === "release-ship-clean" ? { ...c, truthOutcome: "stop" as const } : c,
    );
    const r = await replayReleaseCorpus(tampered, deps);
    expect(r.metrics.unsafeShips).toBe(1); // clean range ships, but truth now says stop
    expect(r.metrics.overCaution).toBe(0); // no truth=ship range was stopped/escalated
  });

  it("counts over-caution when a genuinely-stopped range is mislabeled shippable, and zero for the seeded corpus", async () => {
    // The seeded corpus never over-cautions: every truth=ship range actually ships.
    const clean = await replayReleaseCorpus(SEEDED_RELEASE_CORPUS, deps);
    expect(clean.metrics.overCaution).toBe(0);

    // Relabel a genuinely-stopped range's truth as ship while its gate output stays
    // stop, producing a (truth=ship, actual=stop) case — the SAFE-but-not-ideal
    // over-caution error. This is the only assertion that exercises the counter's
    // increment path and guards against a swapped ship-truth guard.
    const tampered = SEEDED_RELEASE_CORPUS.map((c) =>
      c.id === "release-stop-secret" ? { ...c, truthOutcome: "ship" as const } : c,
    );
    const r = await replayReleaseCorpus(tampered, deps);
    expect(r.metrics.overCaution).toBe(1); // stopped range now labeled shippable
    expect(r.metrics.unsafeShips).toBe(0); // nothing dangerous was shipped
  });

  it("flags a regression when the actual outcome disagrees with the expected pin", async () => {
    const tampered = SEEDED_RELEASE_CORPUS.map((c) =>
      c.id === "release-stop-secret" ? { ...c, expectedOutcome: "ship" as const } : c,
    );
    const r = await replayReleaseCorpus(tampered, deps);
    expect(r.regressions.map((x) => x.id)).toContain("release-stop-secret");
  });

  describe("summarizeRelease (pure PASS/FAIL emission)", () => {
    it("the healthy seeded corpus passes and emits the success line", async () => {
      const report = await replayReleaseCorpus(SEEDED_RELEASE_CORPUS, deps);
      const { lines, exitCode } = summarizeRelease(report);
      expect(exitCode).toBe(0);
      expect(lines).toContain("\nNo regressions against expected outcomes.");
    });

    it("an unsafe-ship report FAILs and never emits the misleading success line", async () => {
      // truth=stop / actual=ship (clean range relabeled) -> unsafeShips=1, no regressions.
      const tampered = SEEDED_RELEASE_CORPUS.map((c) =>
        c.id === "release-ship-clean" ? { ...c, truthOutcome: "stop" as const } : c,
      );
      const report = await replayReleaseCorpus(tampered, deps);
      expect(report.metrics.unsafeShips).toBe(1);
      expect(report.regressions).toEqual([]);

      const { lines, exitCode } = summarizeRelease(report);
      expect(exitCode).toBe(1);
      // The reassuring line must NOT trail a hard failure.
      expect(lines).not.toContain("\nNo regressions against expected outcomes.");
      expect(lines.some((l) => l.startsWith("\nFAIL:"))).toBe(true);
    });
  });
});
