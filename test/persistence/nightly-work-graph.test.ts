import { afterAll, beforeEach, expect, it } from "vitest";
import { describeDb } from "../support/db.js";
import { FixedClock, SeededIdGenerator } from "../../src/platform/clock.js";
import { createPool } from "../../src/persistence/db.js";
import { migrate } from "../../src/persistence/migrate.js";
import { RunStore } from "../../src/persistence/runs.js";
import type { Finding } from "../../src/domain/evidence/types.js";
import { COMPLETE_COVERAGE, coverageFrom } from "../../src/domain/evidence/coverage.js";
import type { NightlyPolicy } from "../../src/domain/policy/types.js";
import { dedupeFindings } from "../../src/domain/findings/identity.js";
import { planNightlyWorkGraph } from "../../src/domain/findings/work-graph.js";
import { NIGHTLY_REPORT_SCHEMA_VERSION, type NightlyReportIdentity } from "../../src/domain/findings/work-identity.js";
import { evaluateNightly } from "../../src/gates/nightly/decision.js";
import { generateFixes } from "../../src/gates/nightly/fix.js";
import { buildNightlyReport } from "../../src/gates/nightly/report.js";
import { TlsFixer } from "../../src/providers/fixers/tls-fixer.js";

/**
 * Durability of the nightly report/work graph: the report, its coverage, the
 * deduplicated finding graph, the intended work items, and the fix proposals all
 * commit in ONE transaction with the run's terminal transition — and re-committing
 * the same immutable report identity produces no duplicate records.
 *
 * This suite is the authority on the SQL. The gate BEHAVIOUR built on top of these
 * guarantees is proved without a database in `test/harness/nightly-work-graph.test.ts`.
 */

const pool = createPool();
const REPO = "acme/web";
const HEAD = "b".repeat(40);
const BRANCH = "main";

const IDENTITY: NightlyReportIdentity = {
  repository: REPO,
  branch: BRANCH,
  baseSha: null,
  headSha: HEAD,
  policyVersion: "policy-v1",
  schemaVersion: NIGHTLY_REPORT_SCHEMA_VERSION,
};

const POLICY: NightlyPolicy = {
  reportableDefectClasses: ["disabled-tls-verification", "leaked-credential"],
  fixableDefectClasses: ["disabled-tls-verification"],
};
const FIXERS = { "disabled-tls-verification": new TlsFixer() };

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "TLS.REJECT_UNAUTHORIZED_FALSE",
    defectClass: "disabled-tls-verification",
    subject: { repository: REPO, commitSha: HEAD },
    primaryRegion: { path: "src/http.ts", startLine: 5, endLine: 5, snippet: "rejectUnauthorized: false" },
    provenance: { analyzerId: "disabled-tls", analyzerVersion: "1.0.0", modelId: null, promptVersion: null },
    supporting: [{ trust: "deterministic", statement: "disables TLS verification" }],
    contradicting: [],
    completeness: { requiredEvidencePresent: true, contextTruncated: false },
    validation: "validated",
    ...overrides,
  };
}

/** The refuted duplicate of a DIFFERENT defect: stays in audit, gets no work item. */
function refutedFinding(): Finding {
  return finding({
    ruleId: "TLS.REJECT_UNAUTHORIZED_FALSE",
    primaryRegion: { path: "test/http.test.ts", startLine: 1, endLine: 1, snippet: "rejectUnauthorized: false" },
    validation: "refuted",
  });
}

function commitInput(rawFindings: Finding[], coverage = COMPLETE_COVERAGE) {
  // Dedupe exactly as the analysis pipeline does before the kernel sees anything.
  const findings = dedupeFindings(rawFindings);
  const { decision, fixes } = generateFixes(findings, evaluateNightly(findings, POLICY, coverage), FIXERS);
  const report = buildNightlyReport({ identity: IDENTITY, findings, decision, fixes });
  return { findings, decision, report, workGraph: planNightlyWorkGraph(report) };
}

async function count(table: string, where = "true", params: unknown[] = []): Promise<number> {
  const result = await pool.query<{ n: string }>(`select count(*) as n from ${table} where ${where}`, params);
  return Number(result.rows[0]!.n);
}

let runs: RunStore;
let clock: FixedClock;

beforeEach(async () => {
  await migrate(pool);
  await pool.query(
    `truncate nightly_work_item_transitions, nightly_fix_proposals, nightly_work_items,
              nightly_report_findings, nightly_reports, outbox, nightly_decisions,
              review_watermarks, run_transitions, evaluation_runs cascade`,
  );
  clock = new FixedClock(new Date("2026-07-15T00:00:00Z"));
  runs = new RunStore(pool, clock, new SeededIdGenerator("t"));
});

afterAll(async () => {
  await pool.end();
});

describeDb("nightly report/work graph durability", () => {
  it("commits one deduplicated work graph atomically", async () => {
    // Two analyzer observations of ONE defect, plus one refuted finding.
    const duplicateOfSameDefect = finding({
      supporting: [{ trust: "model-asserted", statement: "MITM risk" }],
      validation: "validated",
    });
    const input = commitInput([finding(), duplicateOfSameDefect, refutedFinding()]);

    const run = await runs.ensureNightlyRun({ repository: REPO, commitSha: HEAD }, BRANCH, null, "policy-v1");
    const lease = await runs.claimForAnalysis(run.id, "worker-a", 60_000);
    const applied = await runs.commitNightlyDecision({
      runId: run.id,
      from: "analyzing",
      to: "decided",
      reason: "nightly decided",
      report: input.report,
      workGraph: input.workGraph,
      decision: input.decision,
      findings: input.findings,
      effects: [{ effectType: "check_run", externalId: `nightly:${REPO}:${HEAD}`, payload: { title: "x" } }],
      fenceLease: lease!,
    });
    expect(applied).toBe(true);

    // The report, its coverage, and the deduplicated finding graph are all durable.
    expect((await runs.getRun(run.id))?.state).toBe("decided");
    expect(await count("nightly_reports")).toBe(1);
    expect(await count("nightly_decisions", "coverage is not null")).toBe(1);
    // Two observations of one defect -> ONE occurrence row; the refuted one is kept.
    expect(await count("nightly_report_findings")).toBe(2);

    // Exactly one parent, exactly one child for the surviving root cause.
    expect(await count("nightly_work_items", "kind = 'nightly_run'")).toBe(1);
    const children = await pool.query<{ kind: string; occurrence_id: string | null }>(
      "select kind, occurrence_id from nightly_work_items where kind <> 'nightly_run'",
    );
    expect(children.rows).toHaveLength(1);
    expect(children.rows[0]!.kind).toBe("finding");

    // The refuted finding is auditable but has NO work item.
    const refuted = await pool.query<{ occurrence_id: string; visibility: string; remediation: unknown }>(
      "select occurrence_id, visibility, remediation from nightly_report_findings where path = 'test/http.test.ts'",
    );
    expect(refuted.rows[0]!.visibility).toBe("suppressed");
    expect(refuted.rows[0]!.remediation).toBeNull();
    expect(await count("nightly_work_items", "occurrence_id = $1", [refuted.rows[0]!.occurrence_id])).toBe(0);

    // The deterministic patch is durable as a proposal with lifecycle state.
    const proposals = await pool.query<{ delivery: string; ci: string; merge_state: string; branch: string }>(
      "select delivery, ci, merge_state, branch from nightly_fix_proposals",
    );
    expect(proposals.rows).toHaveLength(1);
    expect(proposals.rows[0]).toMatchObject({ delivery: "queued", ci: "unknown", merge_state: "open" });

    // Re-committing the SAME report identity creates no duplicate records. (The run
    // is terminal now, so drive it through a fresh claim as a retry would.)
    await runs.transition(run.id, "decided", "pending", "retry");
    const lease2 = await runs.claimForAnalysis(run.id, "worker-b", 60_000);
    expect(
      await runs.commitNightlyDecision({
        runId: run.id,
        from: "analyzing",
        to: "decided",
        reason: "nightly decided again",
        report: input.report,
        workGraph: input.workGraph,
        decision: input.decision,
        findings: input.findings,
        effects: [{ effectType: "check_run", externalId: `nightly:${REPO}:${HEAD}`, payload: { title: "x" } }],
        fenceLease: lease2!,
      }),
    ).toBe(true);

    expect(await count("nightly_reports")).toBe(1);
    expect(await count("nightly_report_findings")).toBe(2);
    expect(await count("nightly_work_items")).toBe(2);
    expect(await count("nightly_fix_proposals")).toBe(1);
    expect(await count("outbox")).toBe(1);
    // One creation record per work item, not one per commit.
    expect(await count("nightly_work_item_transitions")).toBe(2);
    expect((await runs.getWatermark(REPO, BRANCH))?.lastReviewedHead).toBe(HEAD);
  });

  it("rolls the whole graph back when the guarded transition does not apply", async () => {
    const input = commitInput([finding()]);
    const run = await runs.ensureNightlyRun({ repository: REPO, commitSha: HEAD }, BRANCH, null, "policy-v1");
    // Never claimed: the run is still `pending`, so the `analyzing` guard rejects.
    const applied = await runs.commitNightlyDecision({
      runId: run.id,
      from: "analyzing",
      to: "decided",
      reason: "should not land",
      report: input.report,
      workGraph: input.workGraph,
      decision: input.decision,
      findings: input.findings,
      effects: [{ effectType: "check_run", externalId: "x", payload: {} }],
    });
    expect(applied).toBe(false);

    for (const table of ["nightly_reports", "nightly_report_findings", "nightly_work_items", "nightly_fix_proposals", "outbox"]) {
      expect(await count(table)).toBe(0);
    }
    expect(await runs.getWatermark(REPO, BRANCH)).toBeNull();
  });

  it("persists coverage and holds the complete watermark while a required gap remains", async () => {
    const input = commitInput([], coverageFrom([{ analyzerId: "model-analyzer", code: "provider_unavailable", detail: "503" }]));
    const run = await runs.ensureNightlyRun({ repository: REPO, commitSha: HEAD }, BRANCH, null, "policy-v1");
    const lease = await runs.claimForAnalysis(run.id, "worker-a", 60_000);
    await runs.commitNightlyDecision({
      runId: run.id,
      from: "analyzing",
      to: "decided",
      reason: "nightly decided (incomplete)",
      report: input.report,
      workGraph: input.workGraph,
      decision: input.decision,
      findings: input.findings,
      effects: [{ effectType: "check_run", externalId: "x", payload: {} }],
      fenceLease: lease!,
    });

    const stored = await pool.query<{ coverage: { gaps: unknown[] }; required_coverage_complete: boolean }>(
      "select coverage, required_coverage_complete from nightly_reports",
    );
    expect(stored.rows[0]!.coverage.gaps).toHaveLength(1);
    expect(stored.rows[0]!.required_coverage_complete).toBe(false);

    // Decided, yet NOT completely reviewed: the complete watermark stays absent
    // while the attempted head is on record.
    expect(await runs.getWatermark(REPO, BRANCH)).toBeNull();
    expect(await runs.getReviewProgress(REPO, BRANCH)).toEqual({
      repository: REPO,
      branch: BRANCH,
      lastCompleteHead: null,
      lastAttemptedHead: HEAD,
    });
    expect(await runs.latestNightlyReportForRun(run.id)).toMatchObject({ requiredCoverageComplete: false, headSha: HEAD });

    // The blindness is durable, addressable work.
    const items = await runs.getWorkItems(input.report.reportId);
    expect(items.map((i) => i.kind)).toEqual(["nightly_run", "coverage_gap"]);
    expect(items[1]!.coverageGap).toEqual({ analyzerId: "model-analyzer", code: "provider_unavailable" });
  });

  it("records no work item for a complete, clean run", async () => {
    const input = commitInput([]);
    expect(input.workGraph.parent).toBeNull();

    const run = await runs.ensureNightlyRun({ repository: REPO, commitSha: HEAD }, BRANCH, null, "policy-v1");
    const lease = await runs.claimForAnalysis(run.id, "worker-a", 60_000);
    await runs.commitNightlyDecision({
      runId: run.id,
      from: "analyzing",
      to: "decided",
      reason: "nightly clean",
      report: input.report,
      workGraph: input.workGraph,
      decision: input.decision,
      findings: input.findings,
      effects: [{ effectType: "check_run", externalId: "x", payload: {} }],
      fenceLease: lease!,
    });

    expect(await count("nightly_reports")).toBe(1);
    expect(await count("nightly_work_items")).toBe(0);
    expect((await runs.getWatermark(REPO, BRANCH))?.lastReviewedHead).toBe(HEAD);
  });

  it("resolves a work item a successor report no longer needs, with a recorded reason", async () => {
    const blind = commitInput([], coverageFrom([{ analyzerId: "model-analyzer", code: "provider_unavailable", detail: "503" }]));
    const run = await runs.ensureNightlyRun({ repository: REPO, commitSha: HEAD }, BRANCH, null, "policy-v1");
    const lease = await runs.claimForAnalysis(run.id, "worker-a", 60_000);
    await runs.commitNightlyDecision({
      runId: run.id,
      from: "analyzing",
      to: "decided",
      reason: "blind attempt",
      report: blind.report,
      workGraph: blind.workGraph,
      decision: blind.decision,
      findings: blind.findings,
      effects: [{ effectType: "check_run", externalId: "x", payload: {} }],
      fenceLease: lease!,
    });
    expect(await count("nightly_work_items", "resolution = 'open'")).toBe(2);

    // The successor attempt reviews the same immutable range completely.
    const complete = commitInput([]);
    expect(complete.report.reportId).toBe(blind.report.reportId);
    await runs.transition(run.id, "decided", "pending", "retry");
    const lease2 = await runs.claimForAnalysis(run.id, "worker-b", 60_000);
    await runs.commitNightlyDecision({
      runId: run.id,
      from: "analyzing",
      to: "decided",
      reason: "complete attempt",
      report: complete.report,
      workGraph: complete.workGraph,
      decision: complete.decision,
      findings: complete.findings,
      effects: [{ effectType: "check_run", externalId: "x", payload: {} }],
      fenceLease: lease2!,
    });

    // No new work items, and the stale ones are resolved rather than left open or
    // deleted — the audit trail keeps the history.
    expect(await count("nightly_work_items")).toBe(2);
    expect(await count("nightly_work_items", "resolution = 'open'")).toBe(0);
    const history = await pool.query<{ from_state: string | null; to_state: string; reason: string }>(
      "select from_state, to_state, reason from nightly_work_item_transitions order by work_item_id, seq",
    );
    expect(history.rows.filter((r) => r.from_state === null)).toHaveLength(2);
    expect(history.rows.filter((r) => r.to_state === "resolved" && r.from_state === "open")).toHaveLength(2);
    expect((await runs.getWatermark(REPO, BRANCH))?.lastReviewedHead).toBe(HEAD);
  });

  it("keeps the embedded proposal state in sync with nightly_fix_proposals across a retry", async () => {
    // A fixable finding surfaces alongside a required coverage gap, so the run is
    // legitimately retryable (incomplete coverage) even though the fixable finding
    // itself is unaffected by that gap.
    const input = commitInput([finding()], coverageFrom([{ analyzerId: "model-analyzer", code: "provider_unavailable", detail: "503" }]));
    const run = await runs.ensureNightlyRun({ repository: REPO, commitSha: HEAD }, BRANCH, null, "policy-v1");
    const lease = await runs.claimForAnalysis(run.id, "worker-a", 60_000);
    await runs.commitNightlyDecision({
      runId: run.id,
      from: "analyzing",
      to: "decided",
      reason: "nightly decided (incomplete, fixable finding present)",
      report: input.report,
      workGraph: input.workGraph,
      decision: input.decision,
      findings: input.findings,
      effects: [{ effectType: "check_run", externalId: "x", payload: {} }],
      fenceLease: lease!,
    });

    const proposalId = (await pool.query<{ proposal_id: string }>("select proposal_id from nightly_fix_proposals")).rows[0]!.proposal_id;

    // A later brief (PR publication + CI + merge) progresses the AUTHORITATIVE
    // proposal row far past the fresh-report defaults of queued/unknown/open.
    await pool.query(
      `update nightly_fix_proposals set delivery = 'ready_open', ci = 'passed', merge_state = 'merged' where proposal_id = $1`,
      [proposalId],
    );

    // A retry/successor attempt recomputes the SAME report identity from scratch —
    // its domain-level proposal still carries the fresh queued/unknown/open
    // defaults, because the analysis pipeline has no notion of PR lifecycle state.
    const retryInput = commitInput([finding()], coverageFrom([{ analyzerId: "model-analyzer", code: "provider_unavailable", detail: "503" }]));
    expect(retryInput.report.reportId).toBe(input.report.reportId);
    await runs.transition(run.id, "decided", "pending", "retry");
    const lease2 = await runs.claimForAnalysis(run.id, "worker-b", 60_000);
    await runs.commitNightlyDecision({
      runId: run.id,
      from: "analyzing",
      to: "decided",
      reason: "retry",
      report: retryInput.report,
      workGraph: retryInput.workGraph,
      decision: retryInput.decision,
      findings: retryInput.findings,
      effects: [{ effectType: "check_run", externalId: "x", payload: {} }],
      fenceLease: lease2!,
    });

    // The authoritative row is untouched by the retry (already guaranteed by
    // `on conflict do nothing`/no-op update).
    const authoritative = await pool.query<{ delivery: string; ci: string; merge_state: string }>(
      "select delivery, ci, merge_state from nightly_fix_proposals where proposal_id = $1",
      [proposalId],
    );
    expect(authoritative.rows[0]).toEqual({ delivery: "ready_open", ci: "passed", merge_state: "merged" });

    // The embedded copy in nightly_report_findings.remediation must agree with it —
    // NOT revert to the fresh report's queued/unknown/open defaults.
    const embedded = await pool.query<{ remediation: { proposal: { delivery: string; ci: string; merge: string } } }>(
      "select remediation from nightly_report_findings where path = 'src/http.ts'",
    );
    expect(embedded.rows[0]!.remediation.proposal).toMatchObject({ delivery: "ready_open", ci: "passed", merge: "merged" });
  });

  it("does not advance the complete watermark for an indeterminate run", async () => {
    const input = commitInput([], coverageFrom([{ analyzerId: "analysis", code: "provider_unavailable", detail: "scm down" }]));
    const run = await runs.ensureNightlyRun({ repository: REPO, commitSha: HEAD }, BRANCH, null, "policy-v1");
    const lease = await runs.claimForAnalysis(run.id, "worker-a", 60_000);
    await runs.commitNightlyDecision({
      runId: run.id,
      from: "analyzing",
      to: "indeterminate",
      reason: "analysis failed",
      report: input.report,
      workGraph: input.workGraph,
      decision: input.decision,
      findings: input.findings,
      effects: [{ effectType: "check_run", externalId: "x", payload: {} }],
      fenceLease: lease!,
    });

    expect((await runs.getRun(run.id))?.state).toBe("indeterminate");
    expect(await runs.getWatermark(REPO, BRANCH)).toBeNull();
    // Even an abstention leaves durable, visible work behind.
    expect(await count("nightly_work_items", "kind = 'coverage_gap'")).toBe(1);
  });
});
