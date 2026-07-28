import { beforeEach, describe, expect, it } from "vitest";
import { FixedClock, SeededIdGenerator } from "../../src/platform/clock.js";
import { NightlyService } from "../../src/gates/nightly/service.js";
import { FakeScm } from "../../src/providers/scm/fake.js";
import { defaultAnalyzers, defaultFixers, defaultValidator } from "../../src/providers/registry.js";
import type { Analyzer, AnalyzerResult } from "../../src/providers/analyzers/port.js";
import type { ChangedFile } from "../../src/providers/scm/port.js";
import { planNightlyWorkGraph } from "../../src/domain/findings/work-graph.js";
import { HARNESS_POLICY } from "./boot.js";
import { MemoryNightlyStore } from "../support/memory-nightly-store.js";
import { REPO } from "../fixtures/scenarios.js";

/**
 * The nightly gate driven end to end over a seeded range, asserting the DURABLE
 * report/work graph rather than just the check text.
 *
 * Real domain code in the middle (analyzers, validator, kernel, fix generation,
 * report builder, work-graph planner, service), deterministic edges: a FakeScm, a
 * FixedClock, and an in-memory `NightlyRunStore`. The store double is described in
 * `test/support/memory-nightly-store.ts`; the SQL behind the same guards is proved
 * against real Postgres in `test/persistence/nightly-work-graph.test.ts`.
 *
 * What these tests are for: a night nobody read must not be indistinguishable from
 * a night with nothing to read.
 */

const BRANCH = "main";
const H1 = "a1".repeat(20);
const H2 = "b2".repeat(20);
const LEASE_MS = 1_000;

function newFilePatch(lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

/** A validated leaked credential in prod code: reportable, not a fixable class. */
const REPORT_FILE: ChangedFile = {
  path: "src/config.ts",
  patch: newFilePatch(["export const AWS_KEY = 'AKIAIJKLMNOP12345678';"]),
};
/** A clean file: something changed, nothing wrong with it. */
const CLEAN_FILE: ChangedFile = {
  path: "src/clean.ts",
  patch: newFilePatch(["export const answer = 42;"]),
};

/** An analyzer that reached its backend and could not use the answer. */
class BlindAnalyzer implements Analyzer {
  readonly id = "model-analyzer";
  constructor(private readonly detail = "backend returned 503") {}
  async analyze(): Promise<AnalyzerResult> {
    return { findings: [], gaps: [{ analyzerId: this.id, code: "provider_unavailable", detail: this.detail }] };
  }
}

/** An analyzer that throws on the first call and behaves on every later one. */
class FlakyAnalyzer implements Analyzer {
  readonly id = "flaky-analyzer";
  calls = 0;
  async analyze(): Promise<AnalyzerResult> {
    this.calls += 1;
    if (this.calls === 1) throw new Error("transient backend failure");
    return { findings: [], gaps: [] };
  }
}

interface Rig {
  service: NightlyService;
  store: MemoryNightlyStore;
  scm: FakeScm;
  clock: FixedClock;
}

let rig: Rig;

function boot(analyzers: readonly Analyzer[]): Rig {
  const clock = new FixedClock(new Date("2026-07-15T00:00:00.000Z"));
  const store = new MemoryNightlyStore(clock, new SeededIdGenerator("work-graph"));
  const scm = new FakeScm();
  const service = new NightlyService({
    runs: store,
    scm,
    analyzers,
    validator: defaultValidator(),
    fixers: defaultFixers(),
    policy: HARNESS_POLICY,
    leaseMs: LEASE_MS,
    maxAttempts: 3,
  });
  return { service, store, scm, clock };
}

beforeEach(() => {
  rig = boot(defaultAnalyzers());
});

describe("nightly report work graph", () => {
  it("incomplete nightly never renders clean", async () => {
    // One blind analyzer, zero findings: the exact shape that used to render as a
    // clean bill of health and advance the watermark over unreviewed change.
    rig = boot([...defaultAnalyzers(), new BlindAnalyzer()]);
    rig.scm.seedChangedFilesInRange({ repository: REPO, baseSha: null, headSha: H1 }, [CLEAN_FILE]);

    const result = await rig.service.review({ repository: REPO, branch: BRANCH, head: H1 });
    expect(result.reviewed).toBe(true);

    const report = rig.store.reports()[0]!;
    // 1. The gap is persisted, not dropped on the way to the database.
    expect(report.requiredCoverageComplete).toBe(false);
    expect(report.coverage.gaps).toEqual([
      { analyzerId: "model-analyzer", code: "provider_unavailable", detail: "backend returned 503" },
    ]);
    expect(report.summary).toMatchObject({ surfaced: 0, requiredGaps: 1 });

    // 2. The check does not call the run clean.
    const titles = rig.store.checkTitles();
    expect(titles).toHaveLength(1);
    expect(titles[0]).not.toMatch(/clean/i);
    expect(titles[0]).toMatch(/INCOMPLETE/);
    expect(titles[0]).toMatch(/1 coverage gap/);

    // 3. The complete-review watermark does NOT advance; the attempt is on record.
    expect(await rig.store.getWatermark(REPO, BRANCH)).toBeNull();
    expect(rig.store.lastAttemptedHead(REPO, BRANCH)).toBe(H1);

    // 4. One parent and one coverage-gap child.
    const items = rig.store.workItems(report.reportId);
    expect(items.filter((i) => i.kind === "nightly_run")).toHaveLength(1);
    const gapChildren = items.filter((i) => i.kind === "coverage_gap");
    expect(gapChildren).toHaveLength(1);
    expect(gapChildren[0]!.coverageGap).toEqual({ analyzerId: "model-analyzer", code: "provider_unavailable" });
    expect(gapChildren[0]!.parentWorkItemId).toBe(items.find((i) => i.kind === "nightly_run")!.workItemId);
  });

  it("complete clean nightly creates no issue work", async () => {
    rig.scm.seedChangedFilesInRange({ repository: REPO, baseSha: null, headSha: H1 }, [CLEAN_FILE]);

    await rig.service.review({ repository: REPO, branch: BRANCH, head: H1 });

    const report = rig.store.reports()[0]!;
    expect(report.requiredCoverageComplete).toBe(true);
    expect(report.summary).toEqual({ surfaced: 0, suppressed: 0, proposals: 0, requiredGaps: 0 });
    // The complete watermark advances to the immutable head.
    expect((await rig.store.getWatermark(REPO, BRANCH))?.lastReviewedHead).toBe(H1);
    // ...and nothing was created for a human to close.
    expect(rig.store.workItems()).toEqual([]);
    expect(rig.store.checkTitles()).toEqual(["Nightly review: clean"]);
  });

  it("holds the complete watermark on a required gap even when it DID surface findings", async () => {
    rig = boot([...defaultAnalyzers(), new BlindAnalyzer()]);
    rig.scm.seedChangedFilesInRange({ repository: REPO, baseSha: null, headSha: H1 }, [REPORT_FILE]);

    await rig.service.review({ repository: REPO, branch: BRANCH, head: H1 });

    const report = rig.store.reports()[0]!;
    expect(report.summary).toMatchObject({ surfaced: 1, requiredGaps: 1 });
    expect(await rig.store.getWatermark(REPO, BRANCH)).toBeNull();
    // Both the finding and the blindness are their own child work items.
    const items = rig.store.workItems(report.reportId);
    expect(items.map((i) => i.kind).sort()).toEqual(["coverage_gap", "finding", "nightly_run"]);
  });

  it("retries from the last complete watermark", async () => {
    // Attempt 1 is blind (an analyzer throws), so it commits a terminal report that
    // did NOT completely review the range and does not move the watermark.
    const flaky = new FlakyAnalyzer();
    rig = boot([...defaultAnalyzers(), flaky]);
    rig.scm.seedChangedFilesInRange({ repository: REPO, baseSha: null, headSha: H1 }, [REPORT_FILE]);

    const first = await rig.service.review({ repository: REPO, branch: BRANCH, head: H1 });
    expect(first.reviewed).toBe(true);
    const firstReport = rig.store.reports()[0]!;
    expect(firstReport.requiredCoverageComplete).toBe(false);
    expect(await rig.store.getWatermark(REPO, BRANCH)).toBeNull();
    const itemsAfterFirst = rig.store.workItems(firstReport.reportId).map((i) => i.workItemId).sort();

    // Reviewing the SAME head again starts from the last complete watermark (null),
    // so the range — and therefore the report identity — is unchanged...
    const second = await rig.service.review({ repository: REPO, branch: BRANCH, head: H1 });
    expect(second.reviewed).toBe(true);
    expect(second).toMatchObject({ run: { state: "decided" } });

    // ...the terminal first attempt did not prevent a bounded successor attempt...
    expect(flaky.calls).toBe(2);
    const reports = rig.store.reports();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.reportId).toBe(firstReport.reportId);
    expect(reports[0]!.requiredCoverageComplete).toBe(true);
    expect((await rig.store.getWatermark(REPO, BRANCH))?.lastReviewedHead).toBe(H1);

    // ...and stable identities meant no duplicate work for the same report: the
    // coverage-gap item the first attempt created is resolved rather than reissued.
    const itemsAfterSecond = rig.store.workItems(firstReport.reportId);
    expect(itemsAfterSecond.filter((i) => i.kind === "nightly_run")).toHaveLength(1);
    expect(itemsAfterSecond.filter((i) => i.kind === "finding")).toHaveLength(1);
    const gapItem = itemsAfterSecond.find((i) => i.kind === "coverage_gap")!;
    expect(itemsAfterFirst).toContain(gapItem.workItemId);
    expect(gapItem.resolution).toBe("resolved");
  });

  it("reviews a LATER head from the last complete watermark, not from the failed attempt", async () => {
    const flaky = new FlakyAnalyzer();
    rig = boot([...defaultAnalyzers(), flaky]);
    rig.scm.seedChangedFilesInRange({ repository: REPO, baseSha: null, headSha: H1 }, [REPORT_FILE]);
    await rig.service.review({ repository: REPO, branch: BRANCH, head: H1 });
    expect(await rig.store.getWatermark(REPO, BRANCH)).toBeNull();

    // H2's range must start at the last COMPLETE head (null: nothing has ever been
    // completely reviewed), so the change H1 introduced is not skipped.
    rig.scm.seedChangedFilesInRange({ repository: REPO, baseSha: null, headSha: H2 }, [REPORT_FILE, CLEAN_FILE]);
    const later = await rig.service.review({ repository: REPO, branch: BRANCH, head: H2 });
    expect(later.reviewed).toBe(true);
    expect(later).toMatchObject({ run: { baseSha: null, subject: { commitSha: H2 } } });
    expect((await rig.store.getWatermark(REPO, BRANCH))?.lastReviewedHead).toBe(H2);

    // Two distinct reports: the same defect on a later candidate is new work, never
    // a match against the earlier report's items.
    const [a, b] = rig.store.reports();
    expect(a!.reportId).not.toBe(b!.reportId);
    const occurrences = rig.store.reports().flatMap((r) => r.findings.map((f) => f.occurrenceId));
    expect(new Set(occurrences).size).toBe(occurrences.length);
  });

  it("stops retrying a persistently blind range once attempts are exhausted", async () => {
    // maxAttempts bounds the successor attempts, so a permanently broken analyzer
    // escalates to durable human-visible work instead of spinning forever.
    rig = boot([...defaultAnalyzers(), new BlindAnalyzer("permanently down")]);
    rig.scm.seedChangedFilesInRange({ repository: REPO, baseSha: null, headSha: H1 }, [CLEAN_FILE]);

    for (let i = 0; i < 6; i += 1) await rig.service.review({ repository: REPO, branch: BRANCH, head: H1 });

    const run = (await rig.store.getRun(rig.store.transitions[0]!.runId))!;
    expect(run.attempt).toBe(3); // three claims, then the bound holds
    expect(await rig.store.getWatermark(REPO, BRANCH)).toBeNull();
    // Still exactly one parent and one coverage child for the immutable report.
    expect(rig.store.workItems().filter((i) => i.kind === "nightly_run")).toHaveLength(1);
    expect(rig.store.workItems().filter((i) => i.kind === "coverage_gap")).toHaveLength(1);
  });

  it("plans the same work graph from the persisted report as it committed", async () => {
    // The graph is a pure function of the report, so a later brief that re-reads the
    // report can reconstruct exactly the work this run intended to publish.
    rig = boot([...defaultAnalyzers(), new BlindAnalyzer()]);
    rig.scm.seedChangedFilesInRange({ repository: REPO, baseSha: null, headSha: H1 }, [REPORT_FILE]);
    await rig.service.review({ repository: REPO, branch: BRANCH, head: H1 });

    const report = rig.store.reports()[0]!;
    const replanned = planNightlyWorkGraph(report);
    const stored = rig.store.workItems(report.reportId);
    expect([replanned.parent!, ...replanned.children].map((i) => i.workItemId).sort()).toEqual(
      stored.map((i) => i.workItemId).sort(),
    );
  });
});
