import { describe, expect, it } from "vitest";
import { releaseToCheck } from "./check-run.js";
import { evaluateRelease } from "../gates/release/decision.js";
import {
  assembleReleaseReport,
  type AssembleReleaseReportInput,
} from "../domain/release/report.js";
import { COMPLETE_COVERAGE } from "../domain/evidence/coverage.js";
import type { ReleasePolicy } from "../domain/policy/types.js";
import type { Finding } from "../domain/evidence/types.js";

/**
 * The advisory GitHub check is rendered FROM the persisted report — never from a
 * separately assembled decision — so decision/report/check cannot disagree. These
 * tests pin the load-bearing rendering contract:
 *
 *  - coverage is shown BEFORE finding totals (a clean count over incomplete
 *    coverage is not a clean bill of health);
 *  - a zero-finding sign-off caused by missing evidence shows the GAP, never the
 *    misleading "0 findings need human review";
 *  - partial/failed coverage is never titled "clean";
 *  - the conclusion stays neutral in shadow mode (the check never blocks).
 */

const REPO = "acme/web";
const PREV = "a1".repeat(20);
const CAND = "b2".repeat(20);

/** Every lane required+applicable — the controlled shadow posture. */
const POLICY: ReleasePolicy = {
  stopDefectClasses: ["leaked-credential"],
  signoffDefectClasses: ["disabled-tls-verification"],
  evidence: {
    "source-analysis": { applicable: true, required: true },
    "release-risk-llm": { applicable: true, required: true },
    "candidate-ci": {
      applicable: true,
      required: true,
      requiredContexts: ["ci/build", "ci/tests"],
    },
  },
};

function baseInput(over: Partial<AssembleReleaseReportInput> = {}): AssembleReleaseReportInput {
  return {
    subject: { repository: REPO, previousReleaseSha: PREV, candidateSha: CAND },
    policyVersion: "policy-v1",
    generatedAt: "2026-07-15T00:00:00.000Z",
    provenance: { analyzers: [{ id: "secret-scan" }] },
    findings: [],
    decision: evaluateRelease([], POLICY, COMPLETE_COVERAGE),
    laneDeclarations: POLICY.evidence,
    ...over,
  };
}

const idx = (s: string, needle: string) => s.indexOf(needle);

describe("releaseToCheck rendering", () => {
  it("renders coverage before findings from the persisted report", () => {
    // A CLEAN range (zero findings), but a required candidate-CI lane is incomplete:
    // one named context never reported for the exact candidate. The gate escalates
    // to sign-off with zero findings — the exact shape that must NOT read as clean.
    const decision = evaluateRelease([], POLICY, COMPLETE_COVERAGE, undefined, {
      required: true,
      complete: false,
    });
    expect(decision.outcome).toBe("sign-off-required");
    expect(decision.summary.escalated).toBe(0);

    const report = assembleReleaseReport(
      baseInput({
        decision,
        candidateCi: {
          required: true,
          applicable: true,
          status: "partial",
          observations: ["ci/tests: success"],
          gaps: ["required context 'ci/build' is missing for the candidate"],
        },
      }),
    );

    const { title, summary, conclusion } = releaseToCheck(report);

    // Not clean: neither the title nor the summary may describe this report as clean.
    expect(title.toLowerCase()).not.toContain("clean");
    expect(summary.toLowerCase()).not.toContain("ship (clean)");
    // The misleading "0 findings need human review" wording is forbidden — the real
    // reason is a coverage gap, so the gap/lane must be surfaced instead.
    expect(title).not.toMatch(/0 findings? need human review/i);
    // The holding lane + its gap are visible.
    expect(title).toContain("candidate-ci");
    expect(summary).toContain("candidate-ci: partial");
    expect(summary).toContain("required context 'ci/build' is missing for the candidate");

    // Coverage appears BEFORE the finding totals line.
    expect(idx(summary, "coverage:")).toBeGreaterThanOrEqual(0);
    expect(idx(summary, "findings —")).toBeGreaterThan(idx(summary, "coverage:"));

    // Shadow mode: the check never blocks.
    expect(conclusion).toBe("neutral");
  });

  it("carries candidate/base identity, report id/version, policy and reasons", () => {
    const report = assembleReleaseReport(
      baseInput({
        decision: evaluateRelease([], POLICY, COMPLETE_COVERAGE, undefined, {
          required: true,
          complete: true,
        }),
      }),
    );
    const { summary } = releaseToCheck(report);
    expect(summary).toContain(`candidate: ${CAND}`);
    expect(summary).toContain(`previous release: ${PREV}`);
    expect(summary).toContain(report.reportId);
    expect(summary).toContain("policy policy-v1");
    expect(summary).toContain("reasons:");
  });

  it("never titles an incomplete-coverage ship as clean (defence-in-depth)", () => {
    // A ship decision paired with a partial lane must never read "clean". The kernel
    // blocks this in practice; the renderer guards it anyway.
    const report = assembleReleaseReport(
      baseInput({
        decision: evaluateRelease([], POLICY, COMPLETE_COVERAGE),
        candidateCi: {
          required: true,
          applicable: true,
          status: "partial",
          observations: [],
          gaps: ["ci/build missing"],
        },
      }),
    );
    expect(report.decision.outcome).toBe("ship");
    const { title } = releaseToCheck(report);
    expect(title.toLowerCase()).not.toContain("clean");
    expect(title).toContain("coverage incomplete");
  });

  it("surfaces every unresolved model risk with its citation", () => {
    const finding: Finding[] = [];
    const report = assembleReleaseReport(
      baseInput({
        decision: evaluateRelease(
          finding,
          POLICY,
          COMPLETE_COVERAGE,
          { retainedRiskCount: 1, complete: true },
          { required: true, complete: true },
        ),
        releaseRisk: {
          changeSummary: "adds a background purge job",
          risks: [
            {
              category: "data-integrity",
              scenario: "purge deletes rows a migration still reads",
              affectedSurface: "orders",
              blastRadius: "all orders processed during rollout",
              impact: "data loss",
              detectability: "row-count reconciliation",
              reversibility: "requires backup restoration",
              rollback: "disable the worker and restore affected rows",
              uncertainty: "recovery time is unknown",
              supportingEvidence: ["the purge and migration overlap"],
              contradictingEvidence: [],
              citations: [{ path: "src/purge.ts", line: 3 }],
            },
          ],
          gaps: [],
          reviewedLines: 3,
          totalLines: 3,
          analyzer: { id: "release-risk-analyst", version: "1.1.0" },
          modelId: "fake-model",
          promptVersion: "release-risk-v2",
        },
      }),
    );
    const { title, summary } = releaseToCheck(report);
    expect(report.decision.outcome).toBe("sign-off-required");
    expect(title).toContain("model risk");
    expect(summary).toContain("purge deletes rows a migration still reads");
    expect(summary).toContain("all orders processed during rollout");
    expect(summary).toContain("row-count reconciliation");
    expect(summary).toContain("restore affected rows");
    expect(summary).toContain("the purge and migration overlap");
    expect(summary).toContain("contradicting evidence: none stated");
    expect(summary).toContain("src/purge.ts:3");
    expect(summary).toContain("HUMAN RESPONSIBILITY");
    expect(summary).toContain("personally accept responsibility");
    expect(summary).toContain(report.reportId);
    expect(summary).toContain(CAND);
  });

  it("renders bug issues and open PRs as context-only without changing the outcome", () => {
    const report = assembleReleaseReport(
      baseInput({
        decision: evaluateRelease([], POLICY, COMPLETE_COVERAGE),
        outstandingWork: {
          contextOnly: true,
          repository: {
            status: "complete",
            bugLabel: "bug",
            bugIssues: [
              {
                number: 2,
                url: "https://github.com/acme/web/issues/2",
                title: "Known bug",
                labels: ["bug"],
              },
            ],
            openPullRequests: [
              {
                number: 5,
                url: "https://github.com/acme/web/pull/5",
                title: "Candidate PR",
                draft: false,
                headSha: CAND,
                headBranch: "release/test",
                baseBranch: "main",
                candidate: true,
              },
            ],
            gaps: [],
          },
          nightly: {
            status: "partial",
            reportsConsidered: 0,
            requiredCoverageComplete: false,
            parentIssues: [],
            findings: [],
            gaps: ["no durable nightly reports were available"],
          },
        },
      }),
    );

    expect(report.decision.outcome).toBe("ship");
    const { summary } = releaseToCheck(report);
    expect(summary).toContain("CONTEXT ONLY");
    expect(summary).toContain("bug #2");
    expect(summary).toContain("1 open PR(s)");
    expect(summary).toContain("open PR details collapsed");
    expect(summary).not.toContain("PR #5");
    expect(summary).toContain("no durable nightly reports");
  });

  it("keeps the conclusion neutral for a confirmed stop", () => {
    const finding: Finding = {
      ruleId: "secret-scan/aws",
      defectClass: "leaked-credential",
      subject: { repository: REPO, commitSha: CAND },
      primaryRegion: { path: "src/config.ts", startLine: 1, endLine: 1, snippet: "AKIA..." },
      provenance: {
        analyzerId: "secret-scan",
        analyzerVersion: "1",
        modelId: null,
        promptVersion: null,
      },
      supporting: [{ trust: "deterministic", statement: "matches AWS key shape" }],
      contradicting: [],
      completeness: { requiredEvidencePresent: true, contextTruncated: false },
      validation: "validated",
    };
    const report = assembleReleaseReport(
      baseInput({
        findings: [finding],
        decision: evaluateRelease([finding], POLICY, COMPLETE_COVERAGE),
      }),
    );
    const { title, conclusion } = releaseToCheck(report);
    expect(report.decision.outcome).toBe("stop");
    expect(title).toMatch(/STOP/);
    expect(conclusion).toBe("neutral"); // advisory even for a stop — enforcing authority is a later slice
  });
});
