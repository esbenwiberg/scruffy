import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { describeDb } from "../support/db.js";
import { FixedClock, SeededIdGenerator } from "../../src/platform/clock.js";
import { createPool } from "../../src/persistence/db.js";
import { migrate } from "../../src/persistence/migrate.js";
import { OutboxStore } from "../../src/persistence/outbox.js";
import { PublicationStore } from "../../src/persistence/publications.js";
import { RunStore } from "../../src/persistence/runs.js";
import { EffectsDispatcher } from "../../src/effects/dispatcher.js";
import { planIssuePublicationEffects, type PlannedCheck } from "../../src/effects/publication-plan.js";
import {
  NIGHTLY_CHECK_REFRESH_EFFECT,
  NIGHTLY_ISSUE_EFFECT,
  NIGHTLY_ISSUE_LINK_EFFECT,
  NIGHTLY_ISSUE_SUMMARY_EFFECT,
} from "../../src/effects/issues.js";
import { NIGHTLY_CHECK_NAME } from "../../src/effects/check-run.js";
import { FakeScm } from "../../src/providers/scm/fake.js";
import type { IssueLinkInput, IssueUpsertInput, IssueUpsertResult } from "../../src/providers/scm/port.js";
import { MemoryOutbox, MemoryPublications } from "../support/memory-effects.js";
import {
  FIXTURE_BRANCH,
  FIXTURE_HEAD,
  FIXTURE_REPO,
  reportWithFindingAndCoverageGap,
} from "../support/nightly-graph-fixture.js";

/**
 * Dependent issue effects.
 *
 * The invariant: a child issue cannot be created before its parent's number is on
 * record, an attachment cannot happen before BOTH numbers are, and the final
 * reconciliation cannot happen before every child has settled. Row insertion order
 * is not what enforces that — a retry, an expired claim, or a partly failed batch
 * reorders delivery freely — so the dependency is a declared fact the claim query
 * checks, and these tests are about it holding under exactly those reorderings.
 *
 * The first suite runs everywhere (in-memory outbox/publication doubles that
 * re-implement the production predicates); the second proves the same behaviour
 * through the real SQL when Postgres is reachable.
 */

const CHECK: PlannedCheck = {
  subject: { repository: FIXTURE_REPO, commitSha: FIXTURE_HEAD },
  externalId: `nightly:${FIXTURE_REPO}:${FIXTURE_HEAD}`,
  name: NIGHTLY_CHECK_NAME,
  conclusion: "neutral",
  title: "Nightly review: INCOMPLETE — 1 coverage gap, 1 finding",
  summary: "surfaced: 1, required coverage gaps: 1.",
};

/** A FakeScm whose issue writes fail for chosen markers, to prove failure handling. */
class RefusingIssueScm extends FakeScm {
  constructor(
    private readonly refuseMarkers: Set<string>,
    private readonly refuseLinksForChildNumbers = new Set<number>(),
  ) {
    super();
  }
  override async upsertIssue(input: IssueUpsertInput): Promise<IssueUpsertResult> {
    if (this.refuseMarkers.has(input.marker)) throw new Error(`refused: ${input.title}`);
    return super.upsertIssue(input);
  }
  override async linkChildIssue(input: IssueLinkInput) {
    if (this.refuseLinksForChildNumbers.has(input.child.number)) throw new Error(`refused link for #${input.child.number}`);
    return super.linkChildIssue(input);
  }
}

interface Rig {
  publications: MemoryPublications;
  outbox: MemoryOutbox;
  scm: FakeScm;
  dispatcher: EffectsDispatcher;
  reportId: string;
  parentWorkItemId: string;
  childWorkItemIds: string[];
}

function rig(scm: FakeScm = new FakeScm()): Rig {
  const { report, workGraph } = reportWithFindingAndCoverageGap();
  const publications = new MemoryPublications();
  publications.seedGraph(report.reportId, workGraph);
  const outbox = new MemoryOutbox(publications);
  for (const effect of planIssuePublicationEffects({ report, workGraph, check: CHECK })) outbox.enqueue(effect);
  return {
    publications,
    outbox,
    scm,
    dispatcher: new EffectsDispatcher(outbox, scm, publications),
    reportId: report.reportId,
    parentWorkItemId: workGraph.parent!.workItemId,
    childWorkItemIds: workGraph.children.map((child) => child.workItemId),
  };
}

describe("dependent issue effects (in-memory)", () => {
  it("plans one parent, one child per work item, an attachment each, and two reconciliations", () => {
    const { outbox } = rig();
    const byType = outbox.rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.effectType] = (acc[row.effectType] ?? 0) + 1;
      return acc;
    }, {});
    expect(byType).toEqual({
      [NIGHTLY_ISSUE_EFFECT]: 3, // parent + finding child + coverage child
      [NIGHTLY_ISSUE_LINK_EFFECT]: 2,
      [NIGHTLY_ISSUE_SUMMARY_EFFECT]: 1,
      [NIGHTLY_CHECK_REFRESH_EFFECT]: 1,
    });
  });

  it("children and attachments are NOT claimable until the references they need exist", async () => {
    const r = rig();

    // Before anything is delivered only the parent is claimable: everything else
    // declares a dependency that is unsatisfied.
    expect(r.outbox.blocked()).toHaveLength(6);
    const firstBatch = await r.outbox.claimPending(20);
    expect(firstBatch.map((rec) => rec.effectType)).toEqual([NIGHTLY_ISSUE_EFFECT]);
    // Not claimed is not "sent": the blocked rows are still pending, awaiting retry.
    expect(r.outbox.byStatus("sent")).toHaveLength(0);
  });

  it("dependent effects become deliverable once the required references are persisted", async () => {
    const r = rig();

    // Pass 1: only the parent can go.
    expect(await r.dispatcher.dispatchOnce()).toBe(1);
    const parentRef = await r.publications.getIssueRef(r.parentWorkItemId);
    expect(parentRef).toMatchObject({ provider: "github", number: 1 });
    for (const child of r.childWorkItemIds) expect(await r.publications.getIssueRef(child)).toBeNull();

    // Pass 2: the parent's reference is on record, so both children publish. Their
    // attachments still cannot: the child references did not exist at claim time.
    expect(await r.dispatcher.dispatchOnce()).toBe(2);
    for (const child of r.childWorkItemIds) expect(await r.publications.getIssueRef(child)).not.toBeNull();
    expect(r.publications.record(r.childWorkItemIds[0]!)!.attachedToParent).toBe(false);

    // Pass 3: attachments.
    expect(await r.dispatcher.dispatchOnce()).toBe(2);
    for (const child of r.childWorkItemIds) expect(r.publications.record(child)!.attachedToParent).toBe(true);
    expect(r.scm.recordedSubIssues().get(1)).toEqual([2, 3]);

    // Pass 4: both reconciliations, now that every child has settled.
    expect(await r.dispatcher.dispatchOnce()).toBe(2);
    expect(r.outbox.byStatus("sent")).toHaveLength(7);
    expect(r.outbox.byStatus("failed")).toHaveLength(0);
    expect(r.outbox.blocked()).toHaveLength(0);

    // Exactly one issue per work item — nothing duplicated across four passes.
    expect(r.scm.recordedIssues()).toHaveLength(3);
    // The reconciled parent body reports full publication, and the child bodies link
    // back to the parent by URL.
    const parentIssue = r.scm.recordedIssues().find((i) => i.input.marker.includes("nwi_run"))!;
    expect(parentIssue.input.body).toContain("Every planned work item was filed and attached");
    const childIssue = r.scm.recordedIssues().find((i) => i.input.marker.includes("nwi_fnd"))!;
    expect(childIssue.input.body).toContain(parentRef!.url);
  });

  it("write results survive a retry: a re-dispatched graph converges on the same issues", async () => {
    const r = rig();
    for (let pass = 0; pass < 6; pass += 1) await r.dispatcher.dispatchOnce();

    const refs = await Promise.all([r.parentWorkItemId, ...r.childWorkItemIds].map((id) => r.publications.getIssueRef(id)));
    expect(refs.map((ref) => ref!.number)).toEqual([1, 2, 3]);

    // Re-enqueue the identical graph (a re-commit of the same immutable report) and
    // drain again. The outbox reuses its rows and the marker keeps the writer on the
    // same issues, so nothing is created twice.
    const { report, workGraph } = reportWithFindingAndCoverageGap();
    for (const effect of planIssuePublicationEffects({ report, workGraph, check: CHECK })) r.outbox.enqueue(effect);
    expect(r.outbox.rows).toHaveLength(7);
    for (let pass = 0; pass < 6; pass += 1) await r.dispatcher.dispatchOnce();

    expect(r.scm.recordedIssues()).toHaveLength(3);
    expect(r.scm.recordedSubIssues().get(1)).toEqual([2, 3]);
    const after = await Promise.all([r.parentWorkItemId, ...r.childWorkItemIds].map((id) => r.publications.getIssueRef(id)));
    expect(after).toEqual(refs);
  });

  it("a transient child failure never marks the effect sent, and later succeeds", async () => {
    const { report, workGraph } = reportWithFindingAndCoverageGap();
    const findingChildId = workGraph.children.find((c) => c.kind === "finding")!.workItemId;
    const publications = new MemoryPublications();
    publications.seedGraph(report.reportId, workGraph);
    const outbox = new MemoryOutbox(publications);
    for (const effect of planIssuePublicationEffects({ report, workGraph, check: CHECK })) outbox.enqueue(effect);

    let refuse = true;
    const scm = new (class extends FakeScm {
      override async upsertIssue(input: IssueUpsertInput): Promise<IssueUpsertResult> {
        if (refuse && input.marker.includes("nwi_fnd")) throw new Error("GitHub 502");
        return super.upsertIssue(input);
      }
    })();
    const dispatcher = new EffectsDispatcher(outbox, scm, publications);

    await dispatcher.dispatchOnce(); // parent
    await dispatcher.dispatchOnce(); // both children; the finding child throws
    expect(await publications.getIssueRef(findingChildId)).toBeNull();
    expect(outbox.byStatus("failed")).toHaveLength(0); // retryable, not dead-lettered
    // Its attachment stays blocked, and the reconciliations wait for it to settle.
    expect(outbox.blocked().map((row) => row.effectType).sort()).toEqual([
      NIGHTLY_CHECK_REFRESH_EFFECT,
      NIGHTLY_ISSUE_LINK_EFFECT,
      NIGHTLY_ISSUE_SUMMARY_EFFECT,
    ]);

    refuse = false;
    for (let pass = 0; pass < 5; pass += 1) await dispatcher.dispatchOnce();
    expect(await publications.getIssueRef(findingChildId)).not.toBeNull();
    expect(outbox.byStatus("sent")).toHaveLength(7);
  });

  it("a TERMINAL child failure is visible on the durable report and does not block reconciliation", async () => {
    const { report, workGraph } = reportWithFindingAndCoverageGap();
    const coverageChildId = workGraph.children.find((c) => c.kind === "coverage_gap")!.workItemId;
    const publications = new MemoryPublications();
    publications.seedGraph(report.reportId, workGraph);
    const outbox = new MemoryOutbox(publications);
    for (const effect of planIssuePublicationEffects({ report, workGraph, check: CHECK })) outbox.enqueue(effect);

    const scm = new RefusingIssueScm(new Set([workItemMarker(coverageChildId)]));
    const dispatcher = new EffectsDispatcher(outbox, scm, publications);

    // Drain past the retry budget so the coverage child is dead-lettered.
    for (let pass = 0; pass < 12; pass += 1) await dispatcher.dispatchOnce();

    // The failure is durable against the work item...
    const failed = publications.record(coverageChildId)!;
    expect(failed.issue).toBeNull();
    expect(failed.publicationError).toContain("refused");
    // ...its attachment was cascaded terminally rather than waiting forever...
    const cascaded = outbox.byStatus("failed").map((row) => row.effectType);
    expect(cascaded).toContain(NIGHTLY_ISSUE_LINK_EFFECT);
    expect(outbox.blocked()).toHaveLength(0);
    // ...and BOTH reconciliations still ran, naming the gap.
    expect(outbox.rows.filter((row) => row.effectType === NIGHTLY_CHECK_REFRESH_EFFECT)[0]!.status).toBe("sent");
    const parentBody = scm.recordedIssues().find((i) => i.input.marker.includes("nwi_run"))!.input.body;
    expect(parentBody).toContain("not fully published");
    expect(parentBody).toContain("could not be filed");
    const checkSummary = scm.recordedCheckRuns()[0]!.input.summary;
    expect(checkSummary).toContain("could not be filed");
    expect(checkSummary).not.toContain("Every planned work item was filed");
  });

  it("a terminal PARENT failure fails its dependents instead of leaving them stuck", async () => {
    const { report, workGraph } = reportWithFindingAndCoverageGap();
    const parentId = workGraph.parent!.workItemId;
    const publications = new MemoryPublications();
    publications.seedGraph(report.reportId, workGraph);
    const outbox = new MemoryOutbox(publications);
    for (const effect of planIssuePublicationEffects({ report, workGraph, check: CHECK })) outbox.enqueue(effect);

    const scm = new RefusingIssueScm(new Set([workItemMarker(parentId)]));
    const dispatcher = new EffectsDispatcher(outbox, scm, publications);
    for (let pass = 0; pass < 12; pass += 1) await dispatcher.dispatchOnce();

    expect(publications.record(parentId)!.publicationError).toContain("refused");
    // Nothing is stuck pending, and nothing was falsely marked sent...
    expect(outbox.blocked()).toHaveLength(0);
    expect(outbox.byStatus("pending")).toHaveLength(0);
    // ...the check refresh still ran (it never depended on the parent's reference),
    // so the failure reaches a human even though no issue exists to point at.
    const refresh = outbox.rows.find((row) => row.effectType === NIGHTLY_CHECK_REFRESH_EFFECT)!;
    expect(refresh.status).toBe("sent");
    expect(scm.recordedCheckRuns()[0]!.input.summary).toContain("could not be created");
  });

  it("dead-letters an issue effect when no publication store is wired (never pretends success)", async () => {
    const r = rig();
    const unconfigured = new EffectsDispatcher(r.outbox, r.scm);
    expect(await unconfigured.dispatchOnce()).toBe(0);
    expect(r.outbox.byStatus("failed")).toHaveLength(1);
    expect(r.outbox.byStatus("failed")[0]!.lastError).toContain("issue publication is not configured");
    expect(r.scm.recordedIssues()).toHaveLength(0);
  });
});

function workItemMarker(workItemId: string): string {
  return `<!-- scruffy-work-item-1:${workItemId} -->`;
}

// ── The same invariant through the real SQL ───────────────────────────────────

const pool = createPool();
const clock = new FixedClock(new Date("2026-07-15T00:00:00Z"));

afterAll(async () => {
  await pool.end();
});

describeDb("dependent issue effects (Postgres claim predicate)", () => {
  let runs: RunStore;
  let outbox: OutboxStore;
  let publications: PublicationStore;

  beforeEach(async () => {
    await migrate(pool);
    await pool.query(
      "truncate outbox_dependencies, nightly_work_item_publications, outbox, nightly_work_item_transitions, " +
        "nightly_fix_proposals, nightly_work_items, nightly_report_findings, nightly_reports, nightly_decisions, " +
        "run_transitions, review_watermarks, evaluation_runs cascade",
    );
    runs = new RunStore(pool, clock, new SeededIdGenerator("dep"));
    outbox = new OutboxStore(pool, clock);
    publications = new PublicationStore(pool, clock);
  });

  async function commit(): Promise<{ reportId: string; parentWorkItemId: string; childWorkItemIds: string[] }> {
    const { report, workGraph } = reportWithFindingAndCoverageGap();
    const run = await runs.ensureNightlyRun(
      { repository: FIXTURE_REPO, commitSha: FIXTURE_HEAD },
      FIXTURE_BRANCH,
      null,
      report.identity.policyVersion,
    );
    const lease = await runs.claimForAnalysis(run.id, "test", 60_000);
    const applied = await runs.commitNightlyDecision({
      runId: run.id,
      from: "analyzing",
      to: "decided",
      reason: "test",
      report,
      workGraph,
      decision: { dispositions: [], summary: { reported: 1, proposedFixes: 0, suppressed: 0 }, coverage: report.coverage },
      findings: [],
      effects: planIssuePublicationEffects({ report, workGraph, check: CHECK }),
      ...(lease !== null ? { fenceLease: lease } : {}),
    });
    expect(applied).toBe(true);
    return {
      reportId: report.reportId,
      parentWorkItemId: workGraph.parent!.workItemId,
      childWorkItemIds: workGraph.children.map((c) => c.workItemId),
    };
  }

  it("the claim query withholds every effect whose declared dependency is unsatisfied", async () => {
    const { parentWorkItemId, childWorkItemIds } = await commit();

    // Seven effects on record, six of them blocked on a reference that does not exist.
    expect(await outbox.countPending()).toBe(7);
    expect(await outbox.countBlocked()).toBe(6);
    const claimed = await outbox.claimPending(20);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.effectType).toBe(NIGHTLY_ISSUE_EFFECT);
    // The claim carries what the effect produces, so a dead letter can be attributed.
    expect(claimed[0]!.produces).toEqual({ workItemId: parentWorkItemId, kind: "issue_reference" });

    // Publishing the parent unblocks exactly the two children, not the attachments.
    await publications.recordIssue(parentWorkItemId, "marker", {
      provider: "github",
      number: 10,
      externalId: "10000",
      url: "https://github.com/acme/web/issues/10",
    });
    const secondBatch = await outbox.claimPending(20);
    expect(secondBatch.map((r) => r.effectType).sort()).toEqual([NIGHTLY_ISSUE_EFFECT, NIGHTLY_ISSUE_EFFECT]);

    // Publishing both children unblocks the attachments; the reconciliations still
    // wait, because attachment has not settled.
    for (const [index, child] of childWorkItemIds.entries()) {
      await publications.recordIssue(child, "marker", {
        provider: "github",
        number: 20 + index,
        externalId: `2000${index}`,
        url: `https://github.com/acme/web/issues/${20 + index}`,
      });
    }
    const thirdBatch = await outbox.claimPending(20);
    expect(thirdBatch.map((r) => r.effectType).sort()).toEqual([NIGHTLY_ISSUE_LINK_EFFECT, NIGHTLY_ISSUE_LINK_EFFECT]);

    for (const child of childWorkItemIds) await publications.recordAttachment(child);
    const fourthBatch = await outbox.claimPending(20);
    expect(fourthBatch.map((r) => r.effectType).sort()).toEqual([NIGHTLY_CHECK_REFRESH_EFFECT, NIGHTLY_ISSUE_SUMMARY_EFFECT]);
    expect(await outbox.countBlocked()).toBe(0);
  });

  it("a terminal publication failure settles reconciliation and cascades to reference dependents", async () => {
    const { childWorkItemIds, parentWorkItemId, reportId } = await commit();
    await publications.recordIssue(parentWorkItemId, "marker", {
      provider: "github",
      number: 10,
      externalId: "10000",
      url: "https://github.com/acme/web/issues/10",
    });
    const failedChild = childWorkItemIds[0]!;
    await publications.recordPublicationFailure(failedChild, "GitHub refused the issue");

    // The child's attachment can never happen, so it is cascaded terminally — and
    // the cascade reports the ATTACHMENT the failed effect would have produced, which
    // is how the dispatcher continues the walk instead of leaving it half-done.
    const orphaned = await outbox.failDependentsAwaitingReference(failedChild, "GitHub refused the issue");
    expect(orphaned).toEqual([{ workItemId: failedChild, kind: "attachment" }]);
    const { rows } = await pool.query<{ last_error: string }>(`select last_error from outbox where status = 'failed'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.last_error).toContain("will never be published");

    // ...and the failure SETTLES the child, so reconciliation is no longer blocked
    // once the other child is done: a partly published graph still gets reported.
    await publications.recordIssue(childWorkItemIds[1]!, "marker", {
      provider: "github",
      number: 21,
      externalId: "20001",
      url: "https://github.com/acme/web/issues/21",
    });
    await publications.recordAttachment(childWorkItemIds[1]!);
    const claimed = await outbox.claimPending(20);
    expect(claimed.map((r) => r.effectType)).toContain(NIGHTLY_CHECK_REFRESH_EFFECT);

    const state = (await publications.publicationState(reportId))!;
    expect(state.children.find((c) => c.workItemId === failedChild)!.publicationError).toContain("refused");
    expect(state.children.find((c) => c.workItemId === childWorkItemIds[1]!)!.attachedToParent).toBe(true);
  });

  it("recordPublicationFailure never downgrades an already published work item", async () => {
    const { parentWorkItemId, reportId } = await commit();
    await publications.recordIssue(parentWorkItemId, "marker", {
      provider: "github",
      number: 10,
      externalId: "10000",
      url: "https://github.com/acme/web/issues/10",
    });
    await publications.recordPublicationFailure(parentWorkItemId, "a stale effect failed later");

    const state = (await publications.publicationState(reportId))!;
    expect(state.parent!.issue).toMatchObject({ number: 10 });
    expect(state.parent!.publicationError).toBeNull();
  });

  it("re-committing the same report re-uses the outbox rows and their dependency edges", async () => {
    const first = await commit();
    const beforeIds = await pool.query<{ id: string }>("select id from outbox order by id");
    const beforeDeps = await pool.query<{ n: string }>("select count(*)::text as n from outbox_dependencies");

    await pool.query("update evaluation_runs set state = 'pending', lease_id = null");
    const second = await commit();
    expect(second.reportId).toBe(first.reportId);

    const afterIds = await pool.query<{ id: string }>("select id from outbox order by id");
    const afterDeps = await pool.query<{ n: string }>("select count(*)::text as n from outbox_dependencies");
    expect(afterIds.rows).toEqual(beforeIds.rows);
    expect(afterDeps.rows[0]!.n).toBe(beforeDeps.rows[0]!.n);
  });
});
