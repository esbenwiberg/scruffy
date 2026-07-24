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
  GROUNDED_DETECTION_TARGETS,
  groundedModel,
} from "../../src/corpus/grounded.js";
import { decideGrounded, formatGroundedCase } from "../../src/corpus/grounded-run.js";
import type { ReplayReport } from "../../src/corpus/replay.js";
import type { NightlyReplayReport } from "../../src/corpus/nightly-replay.js";
import type { ReleaseReplayReport } from "../../src/corpus/release-replay.js";
import type { PoisonPolicy, NightlyPolicy, ReleasePolicy } from "../../src/domain/policy/types.js";

/**
 * The grounded corpus is a set of real merged defects — two silent-data-loss
 * shapes (a paginated read that drops pages; a null-gated row mapper) — reproduced
 * from scratch and scored by all three gates with a deterministic, offline model
 * wired in. These tests pin that EVERY grounded case makes each gate do its own
 * job, and that a model finding never leaks beyond the line it anchors to.
 */

const POISON_POLICY: PoisonPolicy = { blockableDefectClasses: [...POISON_BLOCKABLE_CLASSES], requireValidation: true };
const NIGHTLY_POLICY: NightlyPolicy = {
  reportableDefectClasses: [...NIGHTLY_REPORTABLE_CLASSES],
  fixableDefectClasses: [...NIGHTLY_FIXABLE_CLASSES],
};
const RELEASE_POLICY: ReleasePolicy = { stopDefectClasses: [...RELEASE_STOP_CLASSES], signoffDefectClasses: [...RELEASE_SIGNOFF_CLASSES] };

// Model-backed deps: grounded cases are SEMANTIC defects, invisible to the
// deterministic analyzers, so the model analyzer must be wired in.
const withModel = () => [...defaultAnalyzers(), ...modelAnalyzers(groundedModel())];

describe("grounded corpus (real merged defects, model-backed, all three gates)", () => {
  it("has more than one grounded case (broadened beyond a single proof-of-mechanism)", () => {
    expect(GROUNDED_POISON_CORPUS.length).toBeGreaterThan(1);
    expect(GROUNDED_NIGHTLY_CORPUS.length).toBe(GROUNDED_POISON_CORPUS.length);
    expect(GROUNDED_RELEASE_CORPUS.length).toBe(GROUNDED_POISON_CORPUS.length);
  });

  it("conforms to every gate's schema and records auditable, distinct grounding provenance", () => {
    expect(() => Corpus.parse(GROUNDED_POISON_CORPUS)).not.toThrow();
    expect(() => NightlyCorpus.parse(GROUNDED_NIGHTLY_CORPUS)).not.toThrow();
    expect(() => ReleaseCorpus.parse(GROUNDED_RELEASE_CORPUS)).not.toThrow();

    for (const c of GROUNDED_RELEASE_CORPUS) {
      // Rebuilt from scratch (seeded-mutation), grounded in a real merged defect
      // whose lineage is auditable — and NO real bytes cross into this public repo.
      expect(c.provenance.source).toBe("seeded-mutation");
      expect(c.provenance.grounding).toBe("real-merged-defect");
      expect(c.provenance.sourceRepo).toBeTruthy();
      expect(c.provenance.sourceRef).toBeTruthy();
    }
    // Each case cites its own real defect — not all copied from one source.
    const repos = new Set(GROUNDED_RELEASE_CORPUS.map((c) => c.provenance.sourceRef));
    expect(repos.size).toBe(GROUNDED_RELEASE_CORPUS.length);
  });

  it("poison ALLOWS every semantic defect (out of blocking scope) without false-blocking", async () => {
    const r = await replayCorpus(GROUNDED_POISON_CORPUS, { analyzers: withModel(), validator: defaultValidator(), policy: POISON_POLICY });
    expect(r.cases.every((c) => c.outcome === "allow")).toBe(true);
    expect(r.confusion.false_block).toBe(0);
    expect(r.regressions).toEqual([]);
  });

  it("nightly REPORTS every defect — model-asserted, not a fixable class, so no fix PR", async () => {
    const r = await replayNightlyCorpus(GROUNDED_NIGHTLY_CORPUS, {
      analyzers: withModel(),
      validator: defaultValidator(),
      fixers: defaultFixers(),
      policy: NIGHTLY_POLICY,
    });
    for (const c of r.cases) {
      expect(c.correct).toBe(1); // the expected `report` was matched
      expect(c.missed).toBe(0);
      expect(c.falseSurface).toBe(0); // the benign half surfaced nothing
      expect(c.fixesGenerated).toBe(0);
    }
    expect(r.regressions).toEqual([]);
  });

  it("release forces SIGN-OFF on every defect — never a silent ship, never a fabricated stop", async () => {
    const r = await replayReleaseCorpus(GROUNDED_RELEASE_CORPUS, { analyzers: withModel(), validator: defaultValidator(), policy: RELEASE_POLICY });
    expect(r.cases.every((c) => c.outcome === "sign-off-required")).toBe(true);
    expect(r.metrics.unsafeShips).toBe(0);
    expect(r.regressions).toEqual([]);
  });

  it("without a model the semantic defects are invisible — release would UNSAFELY ship them all (why the model path exists)", async () => {
    // The deterministic analyzers alone cannot see a fail-open guard or a null-gated
    // mapper. This pins the exact gap the model analyzer closes: no model -> no
    // finding -> the last gate ships a possible serious regression.
    const r = await replayReleaseCorpus(GROUNDED_RELEASE_CORPUS, {
      analyzers: defaultAnalyzers(),
      validator: defaultValidator(),
      policy: RELEASE_POLICY,
    });
    expect(r.cases.every((c) => c.outcome === "ship")).toBe(true);
    expect(r.metrics.unsafeShips).toBe(GROUNDED_RELEASE_CORPUS.length);
  });

  it("each model finding anchors to its own defect line only — it does not spill onto the benign half", async () => {
    // Strip each case down to its benign file(s) — the file that carries the
    // expected finding is removed. The shared fake model still returns every seed,
    // but none should anchor, so nothing is surfaced for any case.
    const benignOnly = GROUNDED_NIGHTLY_CORPUS.map((c) => {
      const defectPath = c.expected[0]!.path;
      return {
        ...c,
        id: `${c.id}-benign-only`,
        files: c.files.filter((f) => f.path !== defectPath),
        expected: [],
        expectedSummary: { reported: 0, proposedFixes: 0, suppressed: 0 },
      };
    });
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

describe("grounded corpus shas collide ONLY where intended (distinct offset bands)", () => {
  // The real non-collision invariant is the numeric offset band per role (100/200/300),
  // NOT the sha() prefix — which is a constant "a" everywhere. This pins that invariant
  // so a maintainer adding a corpus cannot silently reuse a band and collide.
  const n = GROUNDED_POISON_CORPUS.length;

  it("shares shas exactly where two gates score the same subject/range, and nowhere else", () => {
    // Intended sharing #1: poison subject == detection subject (same commit, two views).
    for (let i = 0; i < n; i++) {
      expect(GROUNDED_POISON_CORPUS[i]!.subject.commitSha).toBe(GROUNDED_DETECTION_TARGETS[i]!.subject.commitSha);
    }
    // Intended sharing #2: nightly and release replay the SAME range (base+head).
    for (let i = 0; i < n; i++) {
      expect(GROUNDED_NIGHTLY_CORPUS[i]!.range.baseSha).toBe(GROUNDED_RELEASE_CORPUS[i]!.range.baseSha);
      expect(GROUNDED_NIGHTLY_CORPUS[i]!.range.headSha).toBe(GROUNDED_RELEASE_CORPUS[i]!.range.headSha);
    }

    // The three ROLES (subject/base/head) must be mutually disjoint bands, each with
    // one distinct sha per case — anything else is an unintended collision.
    const subjects = new Set(GROUNDED_POISON_CORPUS.map((c) => c.subject.commitSha));
    const bases = new Set(GROUNDED_NIGHTLY_CORPUS.map((c) => c.range.baseSha).filter((s): s is string => s !== null));
    const heads = new Set(GROUNDED_NIGHTLY_CORPUS.map((c) => c.range.headSha));
    expect(subjects.size).toBe(n);
    expect(bases.size).toBe(n);
    expect(heads.size).toBe(n);
    // No overlap across roles.
    for (const s of subjects) expect(bases.has(s) || heads.has(s)).toBe(false);
    for (const b of bases) expect(heads.has(b)).toBe(false);

    // Whole-corpus tally: the ONLY duplicates in the full multiset are the two
    // intended shares (subject↔detection, and base/head reused by nightly↔release).
    const all = [
      ...GROUNDED_POISON_CORPUS.map((c) => c.subject.commitSha),
      ...GROUNDED_DETECTION_TARGETS.map((t) => t.subject.commitSha),
      ...GROUNDED_NIGHTLY_CORPUS.flatMap((c) => [c.range.baseSha, c.range.headSha]),
      ...GROUNDED_RELEASE_CORPUS.flatMap((c) => [c.range.baseSha, c.range.headSha]),
    ];
    // 3 distinct roles × n cases = the true count of unique shas.
    expect(new Set(all).size).toBe(3 * n);
  });
});

describe("grounded-run CI gate decision (exit-code logic)", () => {
  // Minimal report stubs carrying only the fields decideGrounded reads.
  const cleanPoison = { regressions: [], confusion: { false_block: 0 } } as unknown as ReplayReport;
  const cleanRelease = { regressions: [], metrics: { unsafeShips: 0 } } as unknown as ReleaseReplayReport;
  const nightly = (cases: { id: string; correct: number; falseSurface: number }[], falseSurface = 0) =>
    ({ regressions: [], totals: { falseSurface }, cases } as unknown as NightlyReplayReport);

  it("passes when every gate handled its cases and no safety metric tripped", () => {
    const d = decideGrounded(cleanPoison, nightly([{ id: "a", correct: 1, falseSurface: 0 }]), cleanRelease);
    expect(d.failed).toBe(false);
    expect(d.mishandledNightly).toEqual([]);
  });

  it("fails when a nightly case is MISHANDLED (correct !== 1) even with a matching summary and no recorded regression", () => {
    // The exact latent divergence: correct=0 but no summary regression pushed.
    const d = decideGrounded(cleanPoison, nightly([{ id: "a", correct: 0, falseSurface: 0 }]), cleanRelease);
    expect(d.failed).toBe(true);
    expect(d.mishandledNightly).toEqual(["a"]);
  });

  it("fails on a poison false-block, mirroring all-run.ts safety gating", () => {
    const poison = { regressions: [], confusion: { false_block: 1 } } as unknown as ReplayReport;
    const d = decideGrounded(poison, nightly([{ id: "a", correct: 1, falseSurface: 0 }]), cleanRelease);
    expect(d.failed).toBe(true);
    expect(d.poisonFalseBlock).toBe(1);
  });

  it("fails on a nightly false-surface even without a per-case correctness miss", () => {
    const d = decideGrounded(cleanPoison, nightly([{ id: "a", correct: 1, falseSurface: 1 }], 1), cleanRelease);
    expect(d.failed).toBe(true);
    expect(d.nightlyFalseSurface).toBe(1);
  });

  it("fails on an unsafe release ship", () => {
    const release = { regressions: [], metrics: { unsafeShips: 1 } } as unknown as ReleaseReplayReport;
    const d = decideGrounded(cleanPoison, nightly([{ id: "a", correct: 1, falseSurface: 0 }]), release);
    expect(d.failed).toBe(true);
    expect(d.releaseUnsafeShips).toBe(1);
  });
});

describe("grounded-run per-case formatting is honest about the gate outcome", () => {
  it("renders the reassuring 'no false-block' claim only when poison actually allowed", () => {
    const good = formatGroundedCase("c1", "repo", "ref", "allow", { correct: 1, falseSurface: 0 }, "sign-off-required");
    expect(good).toContain("no false-block");

    // A regressed poison result must NOT print the reassuring claim next to a block.
    const regressed = formatGroundedCase("c1", "repo", "ref", "block", { correct: 1, falseSurface: 0 }, "sign-off-required");
    expect(regressed).not.toContain("no false-block");
    expect(regressed).toContain("UNEXPECTED");
  });

  it("renders the release sign-off claim only when release actually required sign-off", () => {
    const shipped = formatGroundedCase("c1", "repo", "ref", "allow", { correct: 1, falseSurface: 0 }, "ship");
    expect(shipped).not.toContain("no silent ship");
    expect(shipped).toContain("UNEXPECTED");
  });
});
