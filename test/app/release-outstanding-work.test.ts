import { describe, expect, it } from "vitest";
import { ReleaseOutstandingWorkQuery } from "../../src/app/release-outstanding-work.js";
import type { NightlyEvidenceSnapshot } from "../../src/app/nightly-evidence-query.js";
import type { ScmReader } from "../../src/providers/scm/port.js";

const REPO = "acme/api";
const CANDIDATE = "a".repeat(40);
const subject = { repository: REPO, commitSha: CANDIDATE };

function scm(over: Partial<ScmReader> = {}): ScmReader {
  return {
    async getChangedFiles() {
      return [];
    },
    async getChangedFilesInRange() {
      return [];
    },
    async getFileContent(_subject, path) {
      return { complete: false, path, reason: "not_found" };
    },
    async getCandidateCi() {
      return { sha: CANDIDATE, records: [] };
    },
    async getOpenReleaseWork() {
      return {
        complete: true,
        bugIssues: [
          {
            number: 12,
            url: "https://github.com/acme/api/issues/12",
            title: "Requests can lose updates",
            labels: ["bug", "priority:high"],
          },
        ],
        openPullRequests: [
          {
            number: 19,
            url: "https://github.com/acme/api/pull/19",
            title: "Candidate transport",
            draft: false,
            headSha: CANDIDATE,
            headBranch: "release/candidate",
            baseBranch: "main",
          },
        ],
        gaps: [],
      };
    },
    ...over,
  };
}

function nightlySnapshot(): NightlyEvidenceSnapshot {
  return {
    repository: REPO,
    branch: null,
    candidateSha: null,
    requiredCoverageComplete: true,
    incompleteReports: 0,
    surfacedFindings: 1,
    openFindings: 1,
    awaitingVerification: 0,
    resolvedFindings: 0,
    dismissedFindings: 0,
    openProposals: 1,
    failedProposals: 0,
    reports: [
      {
        reportId: "nr-1",
        repository: REPO,
        branch: "main",
        baseSha: null,
        headSha: "b".repeat(40),
        policyVersion: "policy-v1",
        requiredCoverageComplete: true,
        summary: { surfaced: 1, suppressed: 0, proposals: 1, requiredGaps: 0 },
        coverageGaps: [],
        parentIssue: { number: 2, url: "https://github.com/acme/api/issues/2" },
        createdAt: new Date("2026-07-31T00:00:00Z"),
        findings: [
          {
            occurrenceId: "occ-1",
            findingKey: "tls-key",
            ruleId: "TLS.REJECT_UNAUTHORIZED_FALSE",
            defectClass: "disabled-tls-verification",
            path: "src/client.ts",
            startLine: 4,
            endLine: 4,
            visibility: "surfaced",
            visibilityReason: "reportable",
            resolution: "open",
            issue: { number: 3, url: "https://github.com/acme/api/issues/3" },
            remediation: { state: "proposed", reason: "fix proposed" },
            proposal: {
              proposalId: "nfp-1",
              delivery: "ready_open",
              ci: "passed",
              ciHeadSha: "c".repeat(40),
              merge: "open",
              pullRequest: { number: 4, url: "https://github.com/acme/api/pull/4" },
              deliveryError: null,
            },
            verification: null,
            dismissed: false,
          },
        ],
      },
    ],
  };
}

describe("ReleaseOutstandingWorkQuery", () => {
  it("records bug issues, all open PRs, candidate association and Scruffy nightly work as context only", async () => {
    const query = new ReleaseOutstandingWorkQuery(scm(), {
      async forRepository() {
        return nightlySnapshot();
      },
    });

    const result = await query.read(subject);

    expect(result.contextOnly).toBe(true);
    expect(result.repository.status).toBe("complete");
    expect(result.repository.bugIssues[0]).toMatchObject({
      number: 12,
      labels: ["bug", "priority:high"],
    });
    expect(result.repository.openPullRequests[0]).toMatchObject({ number: 19, candidate: true });
    expect(result.nightly.status).toBe("complete");
    expect(result.nightly.parentIssues).toEqual([
      { number: 2, url: "https://github.com/acme/api/issues/2" },
    ]);
    expect(result.nightly.findings[0]).toMatchObject({
      findingKey: "tls-key",
      issue: { number: 3 },
      proposal: { pullRequest: { number: 4 } },
    });
  });

  it("makes provider failures and absent nightly evidence visible without throwing", async () => {
    const query = new ReleaseOutstandingWorkQuery(
      scm({
        async getOpenReleaseWork() {
          throw new Error("GitHub unavailable");
        },
      }),
      {
        async forRepository() {
          return { ...nightlySnapshot(), reports: [], requiredCoverageComplete: false };
        },
      },
    );

    const result = await query.read(subject);
    expect(result.repository.status).toBe("failed");
    expect(result.repository.gaps.join(" ")).toContain("GitHub unavailable");
    expect(result.nightly.status).toBe("partial");
    expect(result.nightly.gaps.join(" ")).toContain("no durable nightly reports");
  });
});
