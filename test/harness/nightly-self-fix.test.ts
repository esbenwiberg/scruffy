import { afterAll, beforeEach, expect, it } from "vitest";
import { describeDb } from "../support/db.js";
import { createPool } from "../../src/persistence/db.js";
import { migrate } from "../../src/persistence/migrate.js";
import { Scruffy } from "../../src/app/scruffy.js";
import { FixedClock, SeededIdGenerator } from "../../src/platform/clock.js";
import { FakeScm, fakeSha, type FakeIssue, type FakePullRequest } from "../../src/providers/scm/fake.js";
import { FakeModelProvider } from "../../src/providers/models/fake.js";
import { defaultAnalyzers, defaultFixers, defaultValidator, modelAnalyzers } from "../../src/providers/registry.js";
import { PROMPT_VERSION as ANALYZE_PROMPT_VERSION } from "../../src/providers/analyzers/model-analyzer.js";
import { PROMPT_VERSION as FIX_PROMPT_VERSION } from "../../src/providers/prompts/remediation-fix.js";
import { PROMPT_VERSION as CRITIC_PROMPT_VERSION } from "../../src/providers/prompts/remediation-critic.js";
import { NIGHTLY_CHECK_NAME } from "../../src/effects/check-run.js";
import { workItemIssueMarker } from "../../src/domain/findings/work-publication.js";
import type { Analyzer, AnalyzerResult } from "../../src/providers/analyzers/port.js";
import type { ChangedFile } from "../../src/providers/scm/port.js";
import type { ReportChildState, ReportClosureView } from "../../src/persistence/fix-lifecycle.js";
import { HARNESS_POLICY } from "./boot.js";
import { WEBHOOK_SECRET } from "../fixtures/scenarios.js";

/**
 * THE INTEGRATED MORNING FLOW, through Postgres, on the hosted path.
 *
 * Every earlier suite in this series proves one seam. This one proves the product:
 * a scheduled nightly over an installed repository's default branch, carried all the
 * way to what a human finds in the morning — a parent issue, child issues for the
 * work that is actually theirs, a ready fix PR, a clearly-marked draft fix PR, a
 * held watermark, and a run that refuses to call itself done.
 *
 * One range drives the whole pressure case at once, because the interesting
 * failures are interactions:
 *
 *  - `src/http.ts` — a deterministic, validated TLS disable. Deterministic fixer,
 *    so its patch opens READY for review.
 *  - `test/http-client.test.ts` — the same pattern in test code. The adversarial
 *    validator REFUTES it, so it stays in the audit record and reaches no human. If
 *    this one ever grew an issue, Scruffy would be filing work the validator already
 *    cleared.
 *  - `src/orders.ts` — a model-asserted SQL injection. No deterministic fixer, so the
 *    LLM remediation path runs; its patch is structurally safe and policy-compliant
 *    but the critic cannot confirm it, so it opens as a DRAFT.
 *  - a blind advisory analyzer — a required coverage gap, which holds the
 *    complete-review watermark and is itself a child issue, because blindness that
 *    looks clean is the failure this whole series exists to prevent.
 *
 * The trust edges are fakes (a `FakeScm` that mirrors the GitHub adapter's mechanism
 * and a canned model), so nothing here is a claim about live GitHub. Everything
 * BETWEEN those edges — scheduler, gate, remediation, publication, delivery,
 * lifecycle reconciliation, verification, rendering — is the real code against real
 * SQL.
 */

const pool = createPool();

afterAll(async () => {
  await pool.end();
});

const REPO = "acme/api";
/** Deliberately not `main`: nothing in the hosted path may assume that name. */
const BRANCH = "trunk";
const H1 = fakeSha("nightly-head-1");
const H2 = fakeSha("nightly-head-2");
const START = new Date("2026-07-15T02:00:00.000Z");
const CADENCE_MS = 24 * 60 * 60_000;

const TLS_PATH = "src/http.ts";
const TLS_TEST_PATH = "test/http-client.test.ts";
const ORDERS_PATH = "src/orders.ts";

const TLS_LINES = ["import https from 'https';", "const agent = new https.Agent({", "  rejectUnauthorized: false,", "});"];
/** What the deterministic fixer's replacement looks like once merged. */
const TLS_PATCHED = TLS_LINES.join("\n").replace("  rejectUnauthorized: false,", "  rejectUnauthorized: true,");

const ORDERS_LINES = [
  "export async function orderById(db, id) {",
  '  return db.query("select * from orders where id = " + id);',
  "}",
];
const ORDERS_CONTENT = ORDERS_LINES.join("\n");
const ORDERS_PREIMAGE = ORDERS_LINES[1]!;
const ORDERS_REPLACEMENT = '  return db.query("select * from orders where id = $1", [id]);';

/** The model's analysis reply: one semantic finding, anchored to a real added line. */
const MODEL_FINDINGS_JSON = JSON.stringify([
  { class: "sql-injection", path: ORDERS_PATH, line: 2, reason: "the order id is concatenated into the SQL text" },
]);

/** The model's remediation reply: one bounded, anchored edit. */
const MODEL_FIX_JSON = JSON.stringify({
  edits: [
    {
      path: ORDERS_PATH,
      expectedOriginal: ORDERS_PREIMAGE,
      replacement: ORDERS_REPLACEMENT,
      rationale: "bind the id as a query parameter instead of concatenating it",
    },
  ],
});

/**
 * The critic cannot decide. This is the case the brief cares about: structurally
 * safe and policy-compliant, but unconfirmed — so it may reach a human as a DRAFT
 * and must never open ready for review.
 */
const CRITIC_INDETERMINATE_JSON = JSON.stringify({
  verdict: "indeterminate",
  reason: "cannot tell from the shown context whether this driver supports positional parameters",
});

function newFilePatch(lines: readonly string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

const CHANGED_FILES: ChangedFile[] = [
  { path: TLS_PATH, patch: newFilePatch(TLS_LINES) },
  { path: TLS_TEST_PATH, patch: newFilePatch(TLS_LINES) },
  { path: ORDERS_PATH, patch: newFilePatch(ORDERS_LINES) },
];

/**
 * An analyzer that reaches its backend and cannot use the answer. Toggleable so one
 * rig can drive an incomplete night and then a complete successor — the analyzer set
 * is fixed at construction, and swapping the whole process would lose the durable
 * state the successor is supposed to build on.
 */
class AdvisoryAuditAnalyzer implements Analyzer {
  readonly id = "advisory-audit";
  blind = true;
  async analyze(): Promise<AnalyzerResult> {
    if (!this.blind) return { findings: [], gaps: [] };
    return {
      findings: [],
      gaps: [{ analyzerId: this.id, code: "provider_unavailable", detail: "advisory database returned 503" }],
    };
  }
}

interface Rig {
  scruffy: Scruffy;
  scm: FakeScm;
  clock: FixedClock;
  audit: AdvisoryAuditAnalyzer;
}

let rig: Rig;

async function boot(): Promise<Rig> {
  await migrate(pool);
  await pool.query(
    `truncate nightly_finding_verifications, nightly_fix_proposal_transitions,
              nightly_work_item_transitions, nightly_work_item_publications,
              nightly_fix_proposals, nightly_work_items, nightly_report_findings,
              nightly_reports, outbox_dependencies, outbox, nightly_decisions,
              nightly_schedule_state, review_watermarks, run_transitions,
              poison_decisions, release_decisions, evaluation_runs cascade`,
  );

  const clock = new FixedClock(START);
  const scm = new FakeScm();
  const audit = new AdvisoryAuditAnalyzer();
  const model = new FakeModelProvider({
    [ANALYZE_PROMPT_VERSION]: MODEL_FINDINGS_JSON,
    [FIX_PROMPT_VERSION]: MODEL_FIX_JSON,
    [CRITIC_PROMPT_VERSION]: CRITIC_INDETERMINATE_JSON,
  });

  const scruffy = new Scruffy({
    pool,
    clock,
    ids: new SeededIdGenerator("self-fix"),
    policy: HARNESS_POLICY,
    scmReader: scm,
    scmWriter: scm,
    // The SAME fake is the lifecycle reader and the installation reader, mirroring the
    // hosted wiring where one GitHub App reader satisfies all three ports.
    scmLifecycleReader: scm,
    scmInstallationReader: scm,
    analyzers: [...defaultAnalyzers(), ...modelAnalyzers(model), audit],
    validator: defaultValidator(),
    fixers: defaultFixers(),
    model,
    nightlySchedule: { cadenceMs: CADENCE_MS, leaseMs: 30 * 60_000, batchSize: 10, owner: "harness-scheduler" },
    webhookSecret: WEBHOOK_SECRET,
  });

  // Enrollment IS the installation, and the default branch is whatever the provider
  // says it is.
  scm.seedInstalledRepositories([{ repository: REPO, defaultBranch: BRANCH, externalId: "900001" }]);
  return { scruffy, scm, clock, audit };
}

/** Seed the immutable range and the file content the remediation path reads. */
function seedRange(head: string, base: string | null = null): void {
  rig.scm.seedChangedFilesInRange({ repository: REPO, baseSha: base, headSha: head }, CHANGED_FILES);
  // Only `src/orders.ts` is seeded: the model path reads real content to anchor its
  // patch. `src/http.ts` deliberately has NO content at the reviewed head, which is
  // also what makes the first post-merge look indeterminate below.
  rig.scm.seedFileContent({ repository: REPO, commitSha: head }, ORDERS_PATH, ORDERS_CONTENT);
}

/** One hosted scheduling pass, then drain everything it enqueued. */
async function scheduledNight(head: string): Promise<Awaited<ReturnType<Scruffy["scheduleNightly"]>>> {
  rig.scm.setBranchHead(REPO, BRANCH, head);
  const tick = await rig.scruffy.scheduleNightly();
  await rig.scruffy.flushEffects();
  return tick;
}

/**
 * One reconciliation tick. Time moves between ticks because in the hosted loop it
 * does, and the durable state is ordered by when it was observed: two verifications
 * of the same finding at two different post-merge heads are two moments, not one.
 */
async function reconcileTick(): Promise<void> {
  rig.clock.advance(60_000);
  await rig.scruffy.reconcileFixes();
}

async function reportIdFor(head: string): Promise<string> {
  const { rows } = await pool.query<{ report_id: string }>("select report_id from nightly_reports where head_sha = $1", [head]);
  expect(rows).toHaveLength(1);
  return rows[0]!.report_id;
}

/** The durable closure view for one head — the same rows both morning surfaces read. */
async function viewFor(head: string): Promise<ReportClosureView> {
  const views = await rig.scruffy.fixes.openReports(10);
  const view = views.find((v) => v.headSha === head);
  expect(view, `no open report for ${head}`).toBeDefined();
  return view!;
}

function childOf(view: ReportClosureView, predicate: (child: ReportChildState) => boolean): ReportChildState {
  const child = view.children.find(predicate);
  expect(child, "no matching child work item").toBeDefined();
  return child!;
}

const isCoverageChild = (child: ReportChildState): boolean => child.kind === "coverage_gap";
const isTlsChild = (child: ReportChildState): boolean => child.title.includes(TLS_PATH);
const isOrdersChild = (child: ReportChildState): boolean => child.title.includes(ORDERS_PATH);

function prByDraft(draft: boolean): FakePullRequest {
  const found = rig.scm.recordedPullRequests().filter((pr) => pr.draft === draft);
  expect(found, `expected exactly one draft=${draft} pull request`).toHaveLength(1);
  return found[0]!;
}

function issueOf(number: number): FakeIssue {
  const found = rig.scm.recordedIssues().find((i) => i.ref.number === number);
  if (found === undefined) throw new Error(`no issue #${number}`);
  return found;
}

/** The single nightly check for a candidate — same external id as the gate's post. */
function nightlyCheck(head: string): { title: string; summary: string } {
  const runs = rig.scm
    .recordedCheckRuns()
    .filter((c) => c.input.name === NIGHTLY_CHECK_NAME && c.input.subject.commitSha === head);
  expect(runs, `expected exactly one ${NIGHTLY_CHECK_NAME} check for ${head}`).toHaveLength(1);
  return { title: runs[0]!.input.title, summary: runs[0]!.input.summary };
}

/**
 * Publish the night, let the repository's CI report on both PRs, then let a human
 * merge the ready one. Stops at the point a human is looking at in the morning:
 * merged but NOT yet verified.
 */
async function driveToMorning(): Promise<{ ready: FakePullRequest; draft: FakePullRequest }> {
  seedRange(H1);
  await scheduledNight(H1);

  const ready = prByDraft(false);
  const draft = prByDraft(true);

  // Repository-owned CI reports on each PR's own head.
  rig.scm.seedCiEvidence(REPO, ready.headSha, {
    checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
    statuses: [{ context: "ci/lint", state: "success" }],
  });
  rig.scm.seedCiEvidence(REPO, draft.headSha, {
    checkRuns: [{ name: "build", status: "completed", conclusion: "failure" }],
    statuses: [],
  });
  await reconcileTick();

  // A human merges the deterministic fix. Scruffy never does this itself.
  rig.scm.mergePullRequest(REPO, ready.number, fakeSha("merge-commit-ready"));
  await reconcileTick();
  return { ready, draft };
}

describeDb("nightly self-review and fix, integrated (Postgres)", () => {
  beforeEach(async () => {
    rig = await boot();
  });

  it("runs the self-review fixing morning flow", async () => {
    seedRange(H1);
    const tick = await scheduledNight(H1);

    // ── The hosted scheduler drove it, at the resolved default branch head ──────
    expect(tick).toMatchObject({ listed: 1, eligible: 1, claimed: 1, reviewed: 1, listingError: null });
    expect(tick.outcomes).toEqual([{ repository: REPO, branch: BRANCH, head: H1, status: "reviewed", detail: null }]);

    // ── One parent, and children for exactly the actionable work ───────────────
    const reportId = await reportIdFor(H1);
    const publication = (await rig.scruffy.publications.publicationState(reportId))!;
    expect(publication.parent!.kind).toBe("nightly_run");
    expect(publication.parent!.issue).not.toBeNull();
    expect(publication.children.map((c) => c.kind).sort()).toEqual(["coverage_gap", "finding", "finding"]);
    for (const item of [publication.parent!, ...publication.children]) {
      expect(item.issue, `unpublished issue for ${item.workItemId}`).not.toBeNull();
      expect(item.publicationError).toBeNull();
    }
    expect(publication.children.every((c) => c.attachedToParent)).toBe(true);

    // The REFUTED finding is in the audit record and nowhere else: no work item, no
    // issue, no PR, no remediation attempt.
    const view = await viewFor(H1);
    expect(view.summary).toMatchObject({ surfaced: 2, suppressed: 1, proposals: 2, requiredGaps: 1 });
    expect(view.children.some((c) => c.title.includes(TLS_TEST_PATH))).toBe(false);
    const findings = await pool.query<{ visibility: string; path: string }>(
      "select visibility, path from nightly_report_findings where report_id = $1 order by path",
      [reportId],
    );
    expect(findings.rows).toEqual([
      { visibility: "surfaced", path: TLS_PATH },
      { visibility: "surfaced", path: ORDERS_PATH },
      { visibility: "suppressed", path: TLS_TEST_PATH },
    ]);

    // ── The deterministic proposal opens READY, the uncertain LLM one as a DRAFT ─
    const ready = prByDraft(false);
    const draft = prByDraft(true);
    expect(rig.scm.recordedPullRequests()).toHaveLength(2);
    expect(ready.input.title).toBe(`fix(disabled-tls-verification): ${TLS_PATH}:3`);
    expect(draft.input.title).toBe(`[unconfirmed] fix(sql-injection): ${ORDERS_PATH}:2`);
    // The draft's identity is bound to the reviewed candidate, not to a path slug.
    expect(draft.branch).toContain(H1.slice(0, 12));
    // Each PR links its own child issue, so a human lands on the work item.
    expect(ready.input.childIssue!.number).toBe(childOf(view, isTlsChild).issue!.number);
    expect(draft.input.childIssue!.number).toBe(childOf(view, isOrdersChild).issue!.number);

    const tlsRemediation = childOf(view, isTlsChild).remediation;
    expect(tlsRemediation).toMatchObject({ state: "proposed" });
    expect(childOf(view, isOrdersChild).proposal).toMatchObject({ delivery: "draft_open" });
    expect(childOf(view, isTlsChild).proposal).toMatchObject({ delivery: "ready_open" });
    // A coverage gap has nothing to remediate and must not be given a fake proposal.
    expect(childOf(view, isCoverageChild).proposal).toBeNull();

    // ── The complete watermark is HELD while coverage is incomplete ─────────────
    expect(await rig.scruffy.runs.getWatermark(REPO, BRANCH)).toBeNull();
    expect(await rig.scruffy.runs.getReviewProgress(REPO, BRANCH)).toMatchObject({
      lastCompleteHead: null,
      lastAttemptedHead: H1,
    });

    // ── CI belongs to the head it was read at ──────────────────────────────────
    rig.scm.seedCiEvidence(REPO, ready.headSha, {
      checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
      statuses: [{ context: "ci/lint", state: "success" }],
    });
    rig.scm.seedCiEvidence(REPO, draft.headSha, {
      checkRuns: [{ name: "build", status: "completed", conclusion: "failure" }],
      statuses: [],
    });
    await reconcileTick();

    const withCi = await viewFor(H1);
    expect(childOf(withCi, isTlsChild).proposal).toMatchObject({ ci: "passed", ciHeadSha: ready.headSha });
    expect(childOf(withCi, isOrdersChild).proposal).toMatchObject({ ci: "failed", ciHeadSha: draft.headSha });
    // Green CI resolved nothing on its own.
    expect(childOf(withCi, isTlsChild).resolution).toBe("open");

    // Somebody pushes to the draft branch: the old verdict is about a commit nobody
    // is reviewing any more.
    const pushed = fakeSha("draft-head-2");
    rig.scm.advancePullRequestHead(REPO, draft.number, pushed);
    await reconcileTick();
    expect(childOf(await viewFor(H1), isOrdersChild).proposal).toMatchObject({ ci: "unknown", ciHeadSha: null });

    // ── A human merges the ready PR. THAT IS NOT RESOLUTION ────────────────────
    rig.scm.mergePullRequest(REPO, ready.number, fakeSha("merge-commit-ready"));
    await reconcileTick();

    const merged = await viewFor(H1);
    const mergedChild = childOf(merged, isTlsChild);
    expect(mergedChild.proposal).toMatchObject({ merge: "merged" });
    // The post-merge head is readable but the patched path is not, so the verifier ran
    // and could not tell. "Could not tell" keeps the child open.
    expect(mergedChild.verification).toMatchObject({ outcome: "indeterminate" });
    expect(mergedChild.resolution).toBe("awaiting_verification");
    expect(issueOf(mergedChild.issue!.number).state).toBe("open");

    // Only an immutable post-merge candidate that demonstrably carries the patch
    // clears the finding.
    const postMerge = fakeSha("post-merge-1");
    rig.scm.setBranchHead(REPO, BRANCH, postMerge);
    rig.scm.seedFileContent({ repository: REPO, commitSha: postMerge }, TLS_PATH, TLS_PATCHED);
    await reconcileTick();

    const verified = await viewFor(H1);
    const verifiedChild = childOf(verified, isTlsChild);
    expect(verifiedChild.verification).toMatchObject({ outcome: "resolved", subjectSha: postMerge });
    expect(verifiedChild.resolution).toBe("resolved");
    expect(issueOf(verifiedChild.issue!.number)).toMatchObject({ state: "closed" });
    expect(issueOf(verifiedChild.issue!.number).input.stateReason).toBe("completed");

    // ── The parent stays open: a coverage gap and an unresolved child remain ────
    expect(childOf(verified, isOrdersChild).resolution).toBe("open");
    expect(childOf(verified, isCoverageChild).resolution).toBe("open");
    expect(issueOf(verified.parent!.issue!.number).state).toBe("open");
    expect(await rig.scruffy.runs.getWatermark(REPO, BRANCH)).toBeNull();
  });

  it("advances only after complete successor without duplicate work", async () => {
    // ── An incomplete night, fully published ───────────────────────────────────
    seedRange(H1);
    await scheduledNight(H1);
    expect(await rig.scruffy.runs.getWatermark(REPO, BRANCH)).toBeNull();

    const issuesAfterFirst = rig.scm.recordedIssues().length;
    const prsAfterFirst = rig.scm.recordedPullRequests().length;
    expect(issuesAfterFirst).toBe(4); // parent + two findings + one coverage gap
    expect(prsAfterFirst).toBe(2);
    const firstIssueNumbers = rig.scm.recordedIssues().map((i) => i.ref.number);
    const firstPrNumbers = rig.scm.recordedPullRequests().map((pr) => pr.number);

    // ── An exact replay of the first run's effects duplicates nothing ───────────
    // The shape a lease-expiry recovery or an operator-forced re-dispatch takes.
    await pool.query("update outbox set status = 'pending', claimed_at = null, attempts = 0");
    await rig.scruffy.flushEffects();
    expect(rig.scm.recordedIssues().map((i) => i.ref.number)).toEqual(firstIssueNumbers);
    expect(rig.scm.recordedPullRequests().map((pr) => pr.number)).toEqual(firstPrNumbers);

    // ── A later attempt on the SAME head, still blind, is owed and re-driven ────
    rig.clock.advance(CADENCE_MS);
    const retry = await scheduledNight(H1);
    expect(retry.outcomes[0]).toMatchObject({ head: H1, status: "reviewed" });
    // One immutable report identity, one external work graph, however many attempts.
    expect(await pool.query("select report_id from nightly_reports").then((r) => r.rowCount)).toBe(1);
    expect(rig.scm.recordedIssues().map((i) => i.ref.number)).toEqual(firstIssueNumbers);
    expect(rig.scm.recordedPullRequests().map((pr) => pr.number)).toEqual(firstPrNumbers);
    expect(await rig.scruffy.runs.getWatermark(REPO, BRANCH)).toBeNull();

    // ── Coverage recovers and the branch has moved on ──────────────────────────
    rig.audit.blind = false;
    // Base is still null: the last COMPLETE head, not the last attempted one.
    seedRange(H2, null);
    rig.clock.advance(CADENCE_MS);
    const successor = await scheduledNight(H2);
    expect(successor.outcomes[0]).toMatchObject({ head: H2, status: "reviewed", detail: null });

    // Only NOW does the complete watermark move, and it moves to the later head.
    expect(await rig.scruffy.runs.getWatermark(REPO, BRANCH)).toMatchObject({ lastReviewedHead: H2 });
    expect(await rig.scruffy.runs.getReviewProgress(REPO, BRANCH)).toMatchObject({
      lastCompleteHead: H2,
      lastAttemptedHead: H2,
    });

    // ── The successor's work is NEW work, distinguishable from the first run's ──
    const successorView = await viewFor(H2);
    // Complete coverage, so no coverage-gap child this time.
    expect(successorView.children.map((c) => c.kind).sort()).toEqual(["finding", "finding"]);
    expect(successorView.requiredCoverageComplete).toBe(true);

    const successorIssues = rig.scm.recordedIssues().filter((i) => !firstIssueNumbers.includes(i.ref.number));
    expect(successorIssues).toHaveLength(3); // parent + two findings
    const successorPrs = rig.scm.recordedPullRequests().filter((pr) => !firstPrNumbers.includes(pr.number));
    expect(successorPrs).toHaveLength(2);
    // A new candidate is a new proposal identity: the branch carries H2, never H1, so
    // a later occurrence of the same rule/path/line cannot land on the old PR.
    for (const pr of successorPrs) {
      expect(pr.branch).toContain(H2.slice(0, 12));
      expect(pr.branch).not.toContain(H1.slice(0, 12));
    }
    // Every issue is still one issue per work item — markers, not titles, are identity.
    const markers = new Set(rig.scm.recordedIssues().map((i) => i.input.marker));
    expect(markers.size).toBe(rig.scm.recordedIssues().length);
    for (const item of [successorView.parent!, ...successorView.children]) {
      expect(markers.has(workItemIssueMarker(item.workItemId))).toBe(true);
    }

    // A replay of the successor's effects is idempotent too.
    await pool.query("update outbox set status = 'pending', claimed_at = null, attempts = 0");
    await rig.scruffy.flushEffects();
    expect(rig.scm.recordedIssues()).toHaveLength(issuesAfterFirst + 3);
    expect(rig.scm.recordedPullRequests()).toHaveLength(prsAfterFirst + 2);
    // Nothing was left stuck or dead-lettered on the way.
    expect(await rig.scruffy.outbox.countPending()).toBe(0);
    expect(await rig.scruffy.outbox.countFailed()).toBe(0);
  });

  it("renders congruent parent and nightly check", async () => {
    const { ready, draft } = await driveToMorning();

    const view = await viewFor(H1);
    const parentIssue = issueOf(view.parent!.issue!.number);
    const check = nightlyCheck(H1);
    const body = check.summary;

    // ── ONE render, BOTH surfaces ──────────────────────────────────────────────
    // The check summary is the same bytes the parent issue carries (the issue keeps
    // its planned description above the appended morning render).
    expect(parentIssue.input.body).toContain(body);

    // ── Coverage FIRST, in the title and in the body ───────────────────────────
    expect(check.title).toMatch(/^Nightly review: INCOMPLETE — 1 coverage gap, 2 findings \(2 fixes proposed\)/);
    // Three open items: the LLM child, the merged-but-unverified child, and coverage.
    expect(check.title).toContain("3 open items");
    expect(body.indexOf("## Coverage")).toBeLessThan(body.indexOf("## Findings"));
    expect(body).toContain("Required analyzer coverage is **INCOMPLETE**");
    expect(body).toContain("advisory-audit");
    expect(body).toContain("the complete-review watermark is HELD");
    // Neither surface may call this night clean.
    expect(check.title).not.toContain("clean");
    expect(body).not.toContain("clean bill of health.");

    // ── Finding counts, strictly after coverage, congruent with the report ─────
    expect(body).toContain("- surfaced (human work): 2");
    expect(body).toContain("- fix proposals: 2");
    expect(body).toContain("- suppressed or refuted (audit record only, no issue): 1");

    // ── Every external artefact is named and linked ────────────────────────────
    expect(body).toContain(`[#${view.parent!.issue!.number}](${view.parent!.issue!.url})`);
    for (const child of view.children) {
      expect(body).toContain(`[#${child.issue!.number}](${child.issue!.url})`);
      expect(body).toContain(child.title);
    }
    expect(body).toContain(`PR [#${ready.number}](${ready.url})`);
    expect(body).toContain(`PR [#${draft.number}](${draft.url})`);
    // Delivery, CI (with the sha it belongs to) and merge state, per proposal.
    expect(body).toContain(`delivery \`ready_open\`, CI \`passed\` at \`${ready.headSha.slice(0, 12)}\`, merge \`merged\``);
    expect(body).toContain(`delivery \`draft_open\`, CI \`failed\` at \`${draft.headSha.slice(0, 12)}\`, merge \`open\``);
    // The draft's uncertainty is visible where a human reads it.
    expect(body).toContain("Opened as a DRAFT: structurally safe and policy-compliant, but not independently confirmed.");

    // ── Unresolved work is not called done, and nothing claims a merge fixed it ─
    expect(body).toContain("awaiting_verification");
    expect(body).toContain(`\`open\` coverage gap`);
    expect(body).toContain("This run stays open until:");
    expect(body).toContain("Scruffy never merges its own pull requests");
    // No work failed in this run, so the failure section must not be invented.
    expect(body).not.toContain("Fix delivery failed");
    expect(body).not.toContain("issue not published");

    // ── The check is advisory and singular ────────────────────────────────────
    const nightlyRuns = rig.scm.recordedCheckRuns().filter((c) => c.input.name === NIGHTLY_CHECK_NAME);
    expect(nightlyRuns).toHaveLength(1);
    expect(nightlyRuns[0]!.input.conclusion).toBe("neutral");
  });
});
