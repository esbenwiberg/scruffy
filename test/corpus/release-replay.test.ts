import { describe, expect, it } from "vitest";
import { defaultAnalyzers, defaultValidator, RELEASE_STOP_CLASSES, RELEASE_SIGNOFF_CLASSES } from "../../src/providers/registry.js";
import { ReleaseCorpus } from "../../src/corpus/release-types.js";
import { replayReleaseCorpus } from "../../src/corpus/release-replay.js";
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

    expect(r.total).toBe(4);
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
  });

  it("counts an unsafe ship when a stop range is mislabeled shippable", async () => {
    // Sanity-check the safety metric itself: flip a stop range's truth to ship and
    // confirm the replay flags the (now truth=ship, actual=stop) as over-caution,
    // and a genuinely-shipped danger as unsafe. Here we assert the instrument by
    // constructing a case whose gate output is ship but truth is stop.
    const tampered = SEEDED_RELEASE_CORPUS.map((c) =>
      c.id === "release-ship-clean" ? { ...c, truthOutcome: "stop" as const } : c,
    );
    const r = await replayReleaseCorpus(tampered, deps);
    expect(r.metrics.unsafeShips).toBe(1); // clean range ships, but truth now says stop
  });

  it("flags a regression when the actual outcome disagrees with the expected pin", async () => {
    const tampered = SEEDED_RELEASE_CORPUS.map((c) =>
      c.id === "release-stop-secret" ? { ...c, expectedOutcome: "ship" as const } : c,
    );
    const r = await replayReleaseCorpus(tampered, deps);
    expect(r.regressions.map((x) => x.id)).toContain("release-stop-secret");
  });
});
