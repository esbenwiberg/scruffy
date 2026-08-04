import { afterAll, beforeEach, expect, it } from "vitest";
import { describeDb } from "../support/db.js";
import { FixedClock, SeededIdGenerator } from "../../src/platform/clock.js";
import { createPool } from "../../src/persistence/db.js";
import { migrate } from "../../src/persistence/migrate.js";
import { RunStore } from "../../src/persistence/runs.js";
import { ReleaseAuthorityStore } from "../../src/persistence/release-authority.js";
import { assembleReleaseReport, type ReleaseRiskReport } from "../../src/domain/release/report.js";
import {
  buildPrerequisiteSnapshot,
  type ReleasePrerequisiteSnapshot,
} from "../../src/domain/release/prerequisite-snapshot.js";
import { COMPLETE_COVERAGE } from "../../src/domain/evidence/coverage.js";
import type { ReleaseDecision } from "../../src/gates/release/decision.js";
import type { ReleaseAuthorityAssessment } from "../../src/domain/release/authority-change.js";
import type {
  RequiredWorkflowAggregate,
  RequiredWorkflowEvidence,
} from "../../src/domain/release/required-workflow-evidence.js";

/**
 * The successor/history contract for workflow-prerequisite evidence, proven against a
 * real Postgres. For ONE deployment envelope + policy:
 *  - an exact-unchanged evidence retry dedupes onto the SAME run and report;
 *  - a CHANGED evidence snapshot (a rerun's new attempt) creates a DISTINCT successor
 *    run and report — release-run uniqueness is NOT independent of evidence;
 *  - the successor becomes latest for the envelope authority fence, so the previous
 *    report remains historical/inspectable but is no longer current for authorization.
 *
 * The obvious broken implementation keeps release-run uniqueness on the envelope
 * alone; then changed evidence would dedupe onto the first run and the successor
 * assertions below fail.
 */

const REPO = "acme/web";
const PREV = "a1".repeat(20);
const CAND = "b2".repeat(20);
const CAND2 = "c3".repeat(20);
const ARTIFACT = `sha256:${"d4".repeat(32)}`;
const ENV = "shadow-production";
const POLICY_VERSION = "policy-v1";

const SHIP: ReleaseDecision = {
  outcome: "ship",
  reasons: ["no_release_findings"],
  dispositions: [],
  summary: { stopped: 0, escalated: 0, cleared: 0, notRelevant: 0 },
  coverage: COMPLETE_COVERAGE,
};

const pool = createPool();
let runs: RunStore;
let store: ReleaseAuthorityStore;

beforeEach(async () => {
  await migrate(pool);
  await pool.query(
    "truncate outbox, release_decisions, release_reports, run_transitions, evaluation_runs cascade",
  );
  runs = new RunStore(pool, new FixedClock(new Date("2026-08-01T00:00:00Z")), new SeededIdGenerator("t"));
  store = new ReleaseAuthorityStore(pool);
});

afterAll(async () => {
  await pool.end();
});

function evidence(over: Partial<RequiredWorkflowEvidence> = {}): RequiredWorkflowEvidence {
  return {
    workflowId: 7,
    workflowPath: ".github/workflows/ci.yml",
    runId: 100,
    runAttempt: 1,
    event: "push",
    branch: "main",
    candidateSha: CAND,
    status: "completed",
    conclusion: "success",
    url: "https://github.com/acme/web/actions/runs/100",
    ...over,
  };
}

function cleanAuthority(): ReleaseAuthorityAssessment {
  const cfg = { version: 1 as const, requiredWorkflows: [".github/workflows/ci.yml"] };
  return {
    outcome: "clean",
    reasonCode: "authority_unchanged",
    firstAdoption: false,
    configChanged: false,
    changedAuthorityPaths: [],
    addedRequiredWorkflows: [],
    removedRequiredWorkflows: [],
    candidate: { config: cfg, digest: "cfg-a" },
    previous: { config: cfg, digest: "cfg-a" },
    detail: "",
  };
}

function passedAggregate(ev: RequiredWorkflowEvidence): RequiredWorkflowAggregate {
  return {
    outcome: "satisfied",
    reasonCode: "required_workflows_satisfied",
    workflows: [{ workflowPath: ev.workflowPath, state: "passed", evidence: ev }],
  };
}

function makeReport(candidate: string, prerequisite?: ReleasePrerequisiteSnapshot): ReleaseRiskReport {
  return assembleReleaseReport({
    subject: {
      repository: REPO,
      previousReleaseSha: PREV,
      candidateSha: candidate,
      artifactDigest: ARTIFACT,
      targetEnvironment: ENV,
    },
    policyVersion: POLICY_VERSION,
    generatedAt: "2026-08-01T00:00:00.000Z",
    provenance: { analyzers: [{ id: "secret-scan" }] },
    findings: [],
    decision: SHIP,
    ...(prerequisite ? { prerequisite } : {}),
  });
}

async function persistDecided(opts: {
  candidate: string;
  report: ReleaseRiskReport;
  digest: string | null;
}): Promise<{ runId: string }> {
  const run = await runs.ensureReleaseRun(
    { repository: REPO, commitSha: opts.candidate },
    PREV,
    ARTIFACT,
    ENV,
    POLICY_VERSION,
    opts.digest,
  );
  // A dedup retry returns an already-decided run; only a fresh run needs committing.
  if (run.state === "pending") {
    const lease = await runs.claimForAnalysis(run.id, "test", 60_000);
    const ok = await runs.commitReleaseDecision({
      runId: run.id,
      from: "analyzing",
      to: "decided",
      reason: "release ship",
      decision: SHIP,
      report: opts.report,
      findings: [],
      fenceLease: lease!,
    });
    expect(ok).toBe(true);
  }
  return { runId: run.id };
}

async function reportCount(): Promise<number> {
  const r = await pool.query<{ count: string }>("select count(*) from release_reports");
  return Number(r.rows[0]!.count);
}

describeDb("release prerequisite successor persistence", () => {
  it("workflow evidence successor persistence", async () => {
    // Snapshot A: the first green attempt.
    const evA = evidence({ runAttempt: 1, runId: 100 });
    const snapA = buildPrerequisiteSnapshot(cleanAuthority(), passedAggregate(evA));
    const reportA = makeReport(CAND, snapA);
    const a = await persistDecided({ candidate: CAND, report: reportA, digest: snapA.evidenceDigest });

    // An EXACT-unchanged retry converges on the same run and the same report.
    const retry = await runs.ensureReleaseRun(
      { repository: REPO, commitSha: CAND },
      PREV,
      ARTIFACT,
      ENV,
      POLICY_VERSION,
      snapA.evidenceDigest,
    );
    expect(retry.id).toBe(a.runId);
    expect(await reportCount()).toBe(1);

    // Snapshot B: a rerun (a new current attempt). Same envelope, different evidence.
    const evB = evidence({ runAttempt: 2, runId: 100 });
    const snapB = buildPrerequisiteSnapshot(cleanAuthority(), passedAggregate(evB));
    expect(snapB.evidenceDigest).not.toBe(snapA.evidenceDigest);
    const reportB = makeReport(CAND, snapB);
    expect(reportB.reportId).not.toBe(reportA.reportId);

    const b = await persistDecided({ candidate: CAND, report: reportB, digest: snapB.evidenceDigest });

    // The successor is a DISTINCT run and a DISTINCT report — this is the fact the
    // broken "envelope-only uniqueness" implementation cannot satisfy.
    expect(b.runId).not.toBe(a.runId);
    expect(await reportCount()).toBe(2);

    // The envelope authority fence now returns the successor, never the old report.
    const latest = await store.latestReportForEnvelope(reportA.subject);
    expect(latest?.reportId).toBe(reportB.reportId);
    expect(latest?.reportId).not.toBe(reportA.reportId);

    // The previous report is NOT rewritten — it remains historical and inspectable.
    expect((await store.getReport(reportA.reportId))?.reportId).toBe(reportA.reportId);
    expect((await store.getReportForRun(a.runId))?.reportId).toBe(reportA.reportId);
  });
});

describeDb("historical prerequisite report compatibility", () => {
  it("historical prerequisite report compatibility", async () => {
    // A report persisted BEFORE workflow prerequisites became authority: a v2
    // (context-based candidate-CI) report, with no prerequisite snapshot and a null
    // evidence digest on its run.
    const v2 = makeReport(CAND);
    expect(v2.reportVersion).toBe("2");
    await persistDecided({ candidate: CAND, report: v2, digest: null });

    // It remains fully inspectable after the additive migration...
    const inspected = await store.getReport(v2.reportId);
    expect(inspected?.reportVersion).toBe("2");
    // ...but is structurally ineligible for the new prerequisite-aware authorization.
    await expect(store.getPrerequisiteReport(v2.reportId)).resolves.toBeNull();

    // A v3 report carrying a prerequisite snapshot IS eligible under the new contract.
    const snap = buildPrerequisiteSnapshot(cleanAuthority(), passedAggregate(evidence({ candidateSha: CAND2 })));
    const v3 = makeReport(CAND2, snap);
    expect(v3.reportVersion).toBe("3");
    await persistDecided({ candidate: CAND2, report: v3, digest: snap.evidenceDigest });

    const eligible = await store.getPrerequisiteReport(v3.reportId);
    expect(eligible?.reportId).toBe(v3.reportId);
    expect(eligible?.reportVersion).toBe("3");
    // The historical v2 report is still ineligible even alongside a v3 successor era.
    await expect(store.getPrerequisiteReport(v2.reportId)).resolves.toBeNull();
  });
});
