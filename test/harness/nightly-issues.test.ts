import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { describeDb } from "../support/db.js";
import { FixedClock, SeededIdGenerator } from "../../src/platform/clock.js";
import { createPool } from "../../src/persistence/db.js";
import { migrate } from "../../src/persistence/migrate.js";
import { OutboxStore } from "../../src/persistence/outbox.js";
import { PublicationStore } from "../../src/persistence/publications.js";
import { RunStore } from "../../src/persistence/runs.js";
import { EffectsDispatcher } from "../../src/effects/dispatcher.js";
import { NIGHTLY_CHECK_NAME } from "../../src/effects/check-run.js";
import {
  NIGHTLY_CHECK_REFRESH_EFFECT,
  NIGHTLY_ISSUE_EFFECT,
  NIGHTLY_ISSUE_LINK_EFFECT,
  NIGHTLY_ISSUE_SUMMARY_EFFECT,
} from "../../src/effects/issues.js";
import { planIssuePublicationEffects, type PlannedCheck } from "../../src/effects/publication-plan.js";
import { NightlyService } from "../../src/gates/nightly/service.js";
import { FakeScm } from "../../src/providers/scm/fake.js";
import { defaultAnalyzers, defaultFixers, defaultValidator } from "../../src/providers/registry.js";
import type { Analyzer, AnalyzerResult } from "../../src/providers/analyzers/port.js";
import type { ChangedFile } from "../../src/providers/scm/port.js";
import { workItemIssueMarker } from "../../src/domain/findings/work-publication.js";
import { HARNESS_POLICY } from "./boot.js";
import { MemoryNightlyStore } from "../support/memory-nightly-store.js";
import { REPO } from "../fixtures/scenarios.js";
import {
  FIXTURE_BRANCH,
  FIXTURE_HEAD,
  FIXTURE_REPO,
  cleanCompleteReport,
  reportWithFindingAndCoverageGap,
  suppressedOnlyReport,
} from "../support/nightly-graph-fixture.js";

/**
 * Nightly ISSUE publication, end to end.
 *
 * Two questions, deliberately separated:
 *  - does a run that has nothing for a human create nothing? (the always-runnable
 *    suite, driving the real gate over a seeded range with an in-memory store);
 *  - does a run that DOES have something produce the exact parent/child hierarchy in
 *    the database? (the Postgres suite, which is the authority on the SQL).
 *
 * The first is the one that would go unnoticed if it broke: an empty issue for a
 * human to close is noise that trains people to ignore Scruffy, and a suppressed or
 * refuted finding filed as work is worse — it asserts a defect the validator already
 * rejected.
 */

const BRANCH = "main";
const H1 = "a1".repeat(20);
const LEASE_MS = 1_000;

function newFilePatch(lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

/** Something changed, nothing wrong with it. */
const CLEAN_FILE: ChangedFile = {
  path: "src/clean.ts",
  patch: newFilePatch(["export const answer = 42;"]),
};

/** A validated leaked credential in prod code: surfaced, so it IS human work. */
const REPORT_FILE: ChangedFile = {
  path: "src/config.ts",
  patch: newFilePatch([`export const AWS_KEY = '${["AKIA", "IJKLMNOP12345678"].join("")}';`]),
};

/** An analyzer that reached its backend and could not use the answer. */
class BlindAnalyzer implements Analyzer {
  readonly id = "model-analyzer";
  async analyze(): Promise<AnalyzerResult> {
    return { findings: [], gaps: [{ analyzerId: this.id, code: "provider_unavailable", detail: "backend returned 503" }] };
  }
}

function boot(analyzers: readonly Analyzer[]): { service: NightlyService; store: MemoryNightlyStore; scm: FakeScm } {
  const clock = new FixedClock(new Date("2026-07-15T00:00:00.000Z"));
  const store = new MemoryNightlyStore(clock, new SeededIdGenerator("issues"));
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
  return { service, store, scm };
}

/** Effect types enqueued by a run, so a test can assert what publication was planned. */
function effectTypes(store: MemoryNightlyStore): string[] {
  return store.effects.map((effect) => effect.effectType).sort();
}

describe("nightly issue publication planning", () => {
  it("creates no issues for clean or suppressed runs", async () => {
    // 1. A COMPLETE, CLEAN run. Coverage was complete and nothing surfaced, so there
    // is no parent, no child, and no issue effect at all — only the check.
    const clean = boot(defaultAnalyzers());
    clean.scm.seedChangedFilesInRange({ repository: REPO, baseSha: null, headSha: H1 }, [CLEAN_FILE]);
    await clean.service.review({ repository: REPO, branch: BRANCH, head: H1 });

    const cleanReport = clean.store.reports()[0]!;
    expect(cleanReport.requiredCoverageComplete).toBe(true);
    expect(cleanReport.summary).toEqual({ surfaced: 0, suppressed: 0, proposals: 0, requiredGaps: 0 });
    expect(clean.store.workItems()).toEqual([]);
    expect(effectTypes(clean.store)).toEqual(["check_run"]);
    // The check stays congruent with the persisted report: clean, and nothing about
    // issues — it must not imply a publication that never happened.
    expect(clean.store.checkTitles()).toEqual(["Nightly review: clean"]);

    // 2. A run whose only findings are SUPPRESSED/refuted. They stay in the audit
    // record and reach no human: no work item, therefore no issue.
    const { report: suppressedReport, workGraph: suppressedGraph } = suppressedOnlyReport();
    expect(suppressedReport.summary).toMatchObject({ surfaced: 0, suppressed: 1, requiredGaps: 0 });
    // The audit record still holds the refuted finding — suppression is not deletion.
    expect(suppressedReport.findings).toHaveLength(1);
    expect(suppressedReport.findings[0]!.visibility).toBe("suppressed");
    expect(suppressedGraph).toEqual({ parent: null, children: [] });
    expect(
      planIssuePublicationEffects({
        report: suppressedReport,
        workGraph: suppressedGraph,
        check: checkFor(suppressedReport.reportId),
      }),
    ).toEqual([]);

    // 3. And the same for a complete clean report reaching the planner directly.
    const { report: cleanFixture, workGraph: cleanGraph } = cleanCompleteReport();
    expect(planIssuePublicationEffects({ report: cleanFixture, workGraph: cleanGraph, check: checkFor(cleanFixture.reportId) })).toEqual(
      [],
    );
  });

  it("a surfaced finding and a coverage gap DO plan a parent, two children, and reconciliation", async () => {
    // The contrast case, so the test above cannot pass by planning nothing ever.
    const rig = boot([...defaultAnalyzers(), new BlindAnalyzer()]);
    rig.scm.seedChangedFilesInRange({ repository: REPO, baseSha: null, headSha: H1 }, [REPORT_FILE]);
    await rig.service.review({ repository: REPO, branch: BRANCH, head: H1 });

    const report = rig.store.reports()[0]!;
    expect(report.summary).toMatchObject({ surfaced: 1, requiredGaps: 1 });
    expect(effectTypes(rig.store)).toEqual([
      NIGHTLY_CHECK_REFRESH_EFFECT,
      "check_run",
      NIGHTLY_ISSUE_EFFECT,
      NIGHTLY_ISSUE_EFFECT,
      NIGHTLY_ISSUE_EFFECT,
      NIGHTLY_ISSUE_LINK_EFFECT,
      NIGHTLY_ISSUE_LINK_EFFECT,
      NIGHTLY_ISSUE_SUMMARY_EFFECT,
    ].sort());
  });

  it("an ABSTAINED run still plans issues — a night nobody read must reach a human", async () => {
    class BrokenAnalyzer implements Analyzer {
      readonly id = "broken";
      async analyze(): Promise<AnalyzerResult> {
        throw new Error("permanently down");
      }
    }
    const rig = boot([new BrokenAnalyzer()]);
    rig.scm.seedChangedFilesInRange({ repository: REPO, baseSha: null, headSha: H1 }, [CLEAN_FILE]);
    await rig.service.review({ repository: REPO, branch: BRANCH, head: H1 });

    const report = rig.store.reports()[0]!;
    expect(report.requiredCoverageComplete).toBe(false);
    // One parent + one coverage child, published as issues.
    expect(rig.store.effects.filter((e) => e.effectType === NIGHTLY_ISSUE_EFFECT)).toHaveLength(2);
  });

  it("the parent issue body leads with coverage, before any finding count", () => {
    const { workGraph } = reportWithFindingAndCoverageGap();
    const body = workGraph.parent!.body;
    expect(body).toContain("Coverage: INCOMPLETE");
    expect(body.indexOf("Coverage:")).toBeLessThan(body.indexOf("surfaced findings"));
    // The immutable range and the policy/report identity are both on the parent.
    expect(body).toContain(FIXTURE_HEAD);
    expect(body).toContain("policy-v1");
  });
});

function checkFor(reportId: string): PlannedCheck {
  return {
    subject: { repository: FIXTURE_REPO, commitSha: FIXTURE_HEAD },
    externalId: `nightly:${FIXTURE_REPO}:${FIXTURE_HEAD}`,
    name: NIGHTLY_CHECK_NAME,
    conclusion: "neutral",
    title: `check for ${reportId}`,
    summary: "summary",
  };
}

// ── The exact hierarchy, in Postgres ──────────────────────────────────────────

const pool = createPool();
const clock = new FixedClock(new Date("2026-07-15T00:00:00Z"));

afterAll(async () => {
  await pool.end();
});

describeDb("nightly issue publication (Postgres)", () => {
  let runs: RunStore;
  let outbox: OutboxStore;
  let publications: PublicationStore;
  let scm: FakeScm;
  let dispatcher: EffectsDispatcher;

  beforeEach(async () => {
    await migrate(pool);
    await pool.query(
      "truncate outbox_dependencies, nightly_work_item_publications, outbox, nightly_work_item_transitions, " +
        "nightly_fix_proposals, nightly_work_items, nightly_report_findings, nightly_reports, nightly_decisions, " +
        "run_transitions, review_watermarks, evaluation_runs cascade",
    );
    runs = new RunStore(pool, clock, new SeededIdGenerator("harness-issues"));
    outbox = new OutboxStore(pool, clock);
    publications = new PublicationStore(pool, clock);
    scm = new FakeScm();
    dispatcher = new EffectsDispatcher(outbox, scm, publications);
  });

  async function commit(fixture: { report: ReturnType<typeof reportWithFindingAndCoverageGap>["report"]; workGraph: ReturnType<typeof reportWithFindingAndCoverageGap>["workGraph"] }) {
    const { report, workGraph } = fixture;
    const run = await runs.ensureNightlyRun(
      { repository: FIXTURE_REPO, commitSha: FIXTURE_HEAD },
      FIXTURE_BRANCH,
      null,
      report.identity.policyVersion,
    );
    const lease = await runs.claimForAnalysis(run.id, "harness", 60_000);
    const check = checkFor(report.reportId);
    await runs.commitNightlyDecision({
      runId: run.id,
      from: "analyzing",
      to: "decided",
      reason: "harness",
      report,
      workGraph,
      decision: { dispositions: [], summary: { reported: 0, proposedFixes: 0, suppressed: 0 }, coverage: report.coverage },
      findings: [],
      effects: [
        { effectType: "check_run", externalId: check.externalId, payload: { ...check } },
        ...planIssuePublicationEffects({ report, workGraph, check }),
      ],
      ...(lease !== null ? { fenceLease: lease } : {}),
    });
    return report.reportId;
  }

  async function drain(): Promise<void> {
    for (let pass = 0; pass < 10; pass += 1) {
      if ((await dispatcher.dispatchOnce()) === 0) break;
    }
  }

  it("publishes the exact parent/child hierarchy and persists every external reference", async () => {
    const fixture = reportWithFindingAndCoverageGap();
    const reportId = await commit(fixture);
    await drain();

    const state = (await publications.publicationState(reportId))!;
    // One parent, two children — the finding and the coverage gap.
    expect(state.parent!.kind).toBe("nightly_run");
    expect(state.children.map((c) => c.kind).sort()).toEqual(["coverage_gap", "finding"]);

    // Numbers, ids, and urls are all persisted against the matching work items.
    for (const item of [state.parent!, ...state.children]) {
      expect(item.issue).not.toBeNull();
      expect(item.issue!.number).toBeGreaterThan(0);
      expect(item.issue!.externalId).toMatch(/^issue_\d+$/);
      expect(item.issue!.url).toContain(`/${FIXTURE_REPO}/issues/`);
      expect(item.publicationError).toBeNull();
    }
    // Both children attached to the parent, through the native hierarchy.
    expect(state.children.every((c) => c.attachedToParent)).toBe(true);
    expect(scm.recordedSubIssues().get(state.parent!.issue!.number)).toEqual(
      state.children.map((c) => c.issue!.number).sort((a, b) => a - b),
    );

    // Each issue carries the hidden marker derived from its work-item id.
    for (const item of [state.parent!, ...state.children]) {
      const published = scm.recordedIssues().find((i) => i.input.marker === workItemIssueMarker(item.workItemId));
      expect(published, `no issue published for ${item.workItemId}`).toBeDefined();
    }

    // The check was re-posted with the parent link, under the SAME external id, so
    // there is one check run rather than two competing ones.
    const checkRuns = scm.recordedCheckRuns();
    expect(checkRuns).toHaveLength(1);
    expect(checkRuns[0]!.input.summary).toContain(state.parent!.issue!.url);
    expect(await outbox.countFailed()).toBe(0);
    expect(await outbox.countPending()).toBe(0);
  });

  it("creates no issues for a clean complete run", async () => {
    const reportId = await commit(cleanCompleteReport());
    await drain();

    // No work items were planned, so there is no publication state at all...
    expect(await publications.publicationState(reportId)).toBeNull();
    expect(scm.recordedIssues()).toEqual([]);
    expect(scm.recordedSubIssues().size).toBe(0);
    // ...and only the summary check went out.
    expect(scm.recordedCheckRuns()).toHaveLength(1);
    const { rows } = await pool.query<{ effect_type: string }>("select effect_type from outbox");
    expect(rows.map((r) => r.effect_type)).toEqual(["check_run"]);
  });

  it("crash-after-create is recovered by re-dispatch, not duplicated", async () => {
    const fixture = reportWithFindingAndCoverageGap();
    const reportId = await commit(fixture);

    // Simulate the crash: the parent effect reached GitHub, then the process died
    // before the result was persisted. The row goes back to `pending` and the local
    // publication record does not exist.
    await dispatcher.dispatchOnce(1);
    const parentWorkItemId = fixture.workGraph.parent!.workItemId;
    expect(await publications.getIssueRef(parentWorkItemId)).not.toBeNull();
    await pool.query("delete from nightly_work_item_publications where work_item_id = $1", [parentWorkItemId]);
    await pool.query("update outbox set status = 'pending', claimed_at = null where produces_work_item_id = $1", [parentWorkItemId]);

    await drain();

    // The marker put the writer back on the SAME issue: one parent issue, not two.
    const parentIssues = scm.recordedIssues().filter((i) => i.input.marker === workItemIssueMarker(parentWorkItemId));
    expect(parentIssues).toHaveLength(1);
    const state = (await publications.publicationState(reportId))!;
    expect(state.parent!.issue!.number).toBe(parentIssues[0]!.ref.number);
    expect(state.children.every((c) => c.attachedToParent)).toBe(true);
  });

  it("re-dispatching a fully published graph creates no duplicate issue or attachment", async () => {
    const fixture = reportWithFindingAndCoverageGap();
    await commit(fixture);
    await drain();
    const issuesAfterFirst = scm.recordedIssues().length;
    const subIssuesAfterFirst = scm.recordedSubIssues();

    // Re-open every effect and drain again — the shape a lease-expiry recovery or an
    // operator-forced replay takes.
    await pool.query("update outbox set status = 'pending', claimed_at = null, attempts = 0");
    await drain();

    expect(scm.recordedIssues()).toHaveLength(issuesAfterFirst);
    expect(scm.recordedSubIssues()).toEqual(subIssuesAfterFirst);
  });
});
