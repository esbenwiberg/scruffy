import { describe, expect, it } from "vitest";
import {
  parseReleaseArgs,
  formatReleaseReport,
  checkReportCongruence,
  CD_RUNBOOK,
  formatGithubStepSummary,
  formatGithubOutputs,
  releaseCdExitCode,
} from "../../scripts/release-review.js";
import { assembleReleaseReport } from "../../src/domain/release/report.js";
import { releaseToCheck, CheckRunPayload } from "../../src/effects/check-run.js";
import { evaluateRelease } from "../../src/gates/release/decision.js";
import { COMPLETE_COVERAGE } from "../../src/domain/evidence/coverage.js";
import type { ReleasePolicy } from "../../src/domain/policy/types.js";

/**
 * Offline unit tests for the release-review arg boundary. Both the candidate and
 * the previous-release refs are interpolated into a `gh api` path, so parsing must
 * reject `..` traversal / query-fragment splices / control chars BEFORE they reach
 * the URL, and must preserve the omitted-prev-release => null distinction the
 * release range depends on (null = first release over the candidate's own changes).
 *
 * Importing the module must NOT run `main()` (entrypoint-guarded), so these run
 * without any network, real `gh`, or Postgres. The ref-safety and head-resolution
 * seams (isSafeRef / resolveBranchHead) are covered by the nightly-review suite —
 * this module reuses them, so we only test what release adds: the arg parse.
 */

describe("parseReleaseArgs", () => {
  const artifactDigest = `sha256:${"d4".repeat(32)}`;

  it("accepts repo + candidate with a complete deployment envelope", () => {
    expect(
      parseReleaseArgs(["acme/widgets", "v2.0.0", artifactDigest, "shadow-production", "v1.0.0"]),
    ).toEqual({
      repo: "acme/widgets",
      candidateRef: "v2.0.0",
      artifactDigest,
      targetEnvironment: "shadow-production",
      prevRef: "v1.0.0",
    });
  });

  it("treats an omitted previous release as null (first-ever release)", () => {
    expect(parseReleaseArgs(["acme/widgets", "main", artifactDigest, "shadow-production"])).toEqual(
      {
        repo: "acme/widgets",
        candidateRef: "main",
        artifactDigest,
        targetEnvironment: "shadow-production",
        prevRef: null,
      },
    );
  });

  it("rejects missing or malformed envelope fields", () => {
    expect(parseReleaseArgs([])).toBeNull();
    expect(parseReleaseArgs(["not-a-repo", "main", artifactDigest, "shadow"])).toBeNull();
    expect(parseReleaseArgs(["acme/widgets", "main", "sha256:nope", "shadow"])).toBeNull();
    expect(
      parseReleaseArgs(["acme/widgets", "main", artifactDigest, "bad environment"]),
    ).toBeNull();
  });

  it("rejects an unsafe candidate ref (traversal / splice / control char)", () => {
    expect(
      parseReleaseArgs(["acme/widgets", "feature/../../etc", artifactDigest, "shadow"]),
    ).toBeNull();
    expect(parseReleaseArgs(["acme/widgets", "main?foo=bar", artifactDigest, "shadow"])).toBeNull();
    expect(parseReleaseArgs(["acme/widgets", "main\n", artifactDigest, "shadow"])).toBeNull();
  });

  it("rejects an unsafe previous-release ref while the candidate is fine", () => {
    expect(
      parseReleaseArgs(["acme/widgets", "main", artifactDigest, "shadow", "v1..v2"]),
    ).toBeNull();
    expect(
      parseReleaseArgs(["acme/widgets", "main", artifactDigest, "shadow", "tag#frag"]),
    ).toBeNull();
  });
});

/**
 * The manual release script's operator output is rendered from the ONE persisted
 * report (parsed at the read boundary), never a reconstructed decision summary. The
 * renderer is pure over the parsed report, so it is exercised here without a DB:
 * build a report, render it, and prove every operator-visible fact is present and
 * that report/check agreement is checkable.
 */
describe("formatReleaseReport (operator output from the persisted report)", () => {
  const REPO = "acme/web";
  const PREV = "a1".repeat(20);
  const CAND = "b2".repeat(20);

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

  it("prints the complete deployment envelope and persisted release report", () => {
    // A sign-off with a model risk AND a partial candidate-CI lane, so identity,
    // range, lane statuses, risks, gaps and outcome must ALL appear in the output.
    const decision = evaluateRelease(
      [],
      POLICY,
      COMPLETE_COVERAGE,
      { retainedRiskCount: 1, complete: true },
      { required: true, complete: false },
    );
    expect(decision.outcome).toBe("sign-off-required");

    const report = assembleReleaseReport({
      subject: {
        repository: REPO,
        previousReleaseSha: PREV,
        candidateSha: CAND,
        artifactDigest: `sha256:${"d4".repeat(32)}`,
        targetEnvironment: "shadow-production",
      },
      policyVersion: "policy-v1",
      generatedAt: "2026-07-15T00:00:00.000Z",
      provenance: { analyzers: [{ id: "secret-scan" }] },
      findings: [],
      decision,
      laneDeclarations: POLICY.evidence,
      releaseRisk: {
        changeSummary: "adds a background purge job",
        risks: [
          {
            category: "data-integrity",
            scenario: "purge deletes rows a migration still reads",
            affectedSurface: "orders",
            blastRadius: "all orders processed before rollback completes",
            impact: "data loss",
            detectability: "row-count reconciliation after the purge",
            reversibility: "deleted rows require backup restoration",
            rollback: "disable the purge worker and restore affected rows from backup",
            uncertainty: "backup recovery time is not established",
            supportingEvidence: ["the worker deletes rows read by the migration"],
            contradictingEvidence: ["the change includes a feature flag"],
            citations: [{ path: "src/purge.ts", line: 3 }],
          },
        ],
        gaps: [],
        reviewedLines: 5,
        totalLines: 5,
        analyzer: { id: "release-risk-analyst", version: "1.1.0" },
        modelId: "fake-model",
        promptVersion: "release-risk-v2",
      },
      candidateCi: {
        required: true,
        applicable: true,
        status: "partial",
        observations: ["ci/tests: success"],
        gaps: ["required context 'ci/build' is missing for the candidate"],
      },
      outstandingWork: {
        contextOnly: true,
        repository: {
          status: "complete",
          bugLabel: "bug",
          bugIssues: [
            {
              number: 12,
              url: "https://github.com/acme/web/issues/12",
              title: "Purge can race migration",
              labels: ["bug"],
            },
          ],
          openPullRequests: [
            {
              number: 15,
              url: "https://github.com/acme/web/pull/15",
              title: "Release candidate",
              draft: false,
              headSha: CAND,
              headBranch: "release/candidate",
              baseBranch: "main",
              candidate: true,
            },
          ],
          gaps: [],
        },
        nightly: {
          status: "partial",
          reportsConsidered: 1,
          requiredCoverageComplete: false,
          parentIssues: [{ number: 20, url: "https://github.com/acme/web/issues/20" }],
          findings: [],
          gaps: ["one nightly report has incomplete required coverage"],
        },
      },
    });

    const out = formatReleaseReport(report).join("\n");

    // Report identity + version + policy.
    expect(out).toContain(report.reportId);
    expect(out).toContain("v1");
    expect(out).toContain("policy-v1");
    // Immutable range.
    expect(out).toContain(CAND);
    expect(out).toContain(PREV);
    expect(out).toContain(report.subject.artifactDigest);
    expect(out).toContain(report.subject.targetEnvironment);
    // Lane statuses.
    expect(out).toContain("source-analysis: complete");
    expect(out).toContain("release-risk-llm: complete");
    expect(out).toContain("candidate-ci: partial");
    // Gaps + missing-evidence callout.
    expect(out).toContain("required context 'ci/build' is missing for the candidate");
    expect(out).toContain("MISSING EVIDENCE");
    // Model risk + its citation.
    expect(out).toContain("purge deletes rows a migration still reads");
    expect(out).toContain("all orders processed before rollback completes");
    expect(out).toContain("row-count reconciliation");
    expect(out).toContain("restore affected rows from backup");
    expect(out).toContain("backup recovery time is not established");
    expect(out).toContain("the worker deletes rows");
    expect(out).toContain("the change includes a feature flag");
    expect(out).toContain("src/purge.ts:3");
    // Bugs remain visible; open PRs are counted but collapsed as future work.
    expect(out).toContain("bug #12");
    expect(out).toContain("1 open PR(s)");
    expect(out).toContain("Open PRs are future work");
    expect(out).not.toContain("PR #15");
    expect(out).toContain("context only");
    // The exact SHA/report-bound responsibility statement is prominent.
    expect(out).toContain("HUMAN RESPONSIBILITY");
    expect(out).toContain("personally accept responsibility");
    expect(out).toContain(report.reportId);
    // Change summary + outcome.
    expect(out).toContain("adds a background purge job");
    expect(out).toContain("sign-off-required");

    // Coverage is rendered BEFORE finding totals.
    expect(out.indexOf("Coverage (evidence lanes):")).toBeLessThan(out.indexOf("Findings —"));

    // CD-native presentation writes the report and stable routing outputs into
    // Actions-owned files; it never asks for or advertises a PR/commit check.
    const jobSummary = formatGithubStepSummary(report);
    expect(jobSummary).toContain("Scruffy release risk report");
    expect(jobSummary).toContain(report.reportId);
    expect(jobSummary).toContain("Full deployment evidence");
    expect(formatGithubOutputs(report)).toContain("outcome=sign-off-required");
    expect(formatGithubOutputs(report)).toContain(
      `artifact_digest=${report.subject.artifactDigest}`,
    );
    expect(formatGithubOutputs(report)).toContain(
      `target_environment=${report.subject.targetEnvironment}`,
    );
    expect(formatGithubOutputs(report)).toContain("signoff_required=true");
    expect(releaseCdExitCode(report.decision.outcome)).toBe(0); // route to protected environment
    expect(releaseCdExitCode("ship")).toBe(0);
    expect(releaseCdExitCode("stop")).toBe(1);
    expect(releaseCdExitCode("indeterminate")).toBe(1);
    expect(CD_RUNBOOK.join("\n")).toMatch(/npm run scruffy:release/);
    expect(CD_RUNBOOK.join("\n")).toMatch(/never posts a commit status or check/i);
  });

  it("flags a report/check mismatch and confirms agreement for a congruent pair", () => {
    const decision = evaluateRelease(
      [],
      POLICY,
      COMPLETE_COVERAGE,
      { retainedRiskCount: 0, complete: true },
      { required: true, complete: true },
    );
    const report = assembleReleaseReport({
      subject: {
        repository: REPO,
        previousReleaseSha: PREV,
        candidateSha: CAND,
        artifactDigest: `sha256:${"d4".repeat(32)}`,
        targetEnvironment: "shadow-production",
      },
      policyVersion: "policy-v1",
      generatedAt: "2026-07-15T00:00:00.000Z",
      provenance: { analyzers: [{ id: "secret-scan" }] },
      findings: [],
      decision,
      laneDeclarations: POLICY.evidence,
      releaseRisk: {
        changeSummary: "",
        risks: [],
        gaps: [],
        reviewedLines: 2,
        totalLines: 2,
        analyzer: { id: "release-risk-analyst", version: "1.1.0" },
        modelId: "fake-model",
        promptVersion: "release-risk-v2",
      },
      candidateCi: {
        required: true,
        applicable: true,
        status: "complete",
        observations: [],
        gaps: [],
      },
    });

    // The check rendered from the same report is congruent.
    const check = releaseToCheck(report);
    const payload: CheckRunPayload = {
      subject: { repository: REPO, commitSha: CAND },
      externalId: `release:${REPO}:${CAND}`,
      name: "scruffy/release",
      conclusion: check.conclusion,
      title: check.title,
      summary: check.summary,
    };
    expect(checkReportCongruence(report, payload).agree).toBe(true);

    // A tampered check summary (wrong outcome, no report id) is caught.
    const tampered = { ...payload, summary: "outcome: ship — reasons: none." };
    const bad = checkReportCongruence(report, tampered);
    expect(bad.agree).toBe(false);
    expect(bad.lines.join("\n")).toMatch(/MISMATCH/);
  });
});
