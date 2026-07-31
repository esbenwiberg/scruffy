import type { SubjectRevision } from "../domain/evidence/types.js";
import {
  ReleaseOutstandingWork,
  type ReleaseOutstandingWork as ReleaseOutstandingWorkSnapshot,
  type ReleaseOutstandingWorkReader,
} from "../domain/release/outstanding-work.js";
import type { ScmReader } from "../providers/scm/port.js";
import type { NightlyEvidenceQuery } from "./nightly-evidence-query.js";

/** Newest-first nightly reports considered when presenting unresolved context. */
export const NIGHTLY_CONTEXT_REPORT_LIMIT = 20;

/**
 * Read-only aggregation of two factual context sources. Neither source feeds the
 * release decision: this object is called only to populate the report's
 * `outstandingWork` presentation snapshot.
 */
export class ReleaseOutstandingWorkQuery implements ReleaseOutstandingWorkReader {
  constructor(
    private readonly scm: ScmReader,
    private readonly nightly: Pick<NightlyEvidenceQuery, "forRepository">,
  ) {}

  async read(subject: SubjectRevision): Promise<ReleaseOutstandingWorkSnapshot> {
    const [repository, nightly] = await Promise.all([
      this.#repository(subject),
      this.#nightly(subject.repository),
    ]);
    return ReleaseOutstandingWork.parse({ contextOnly: true, repository, nightly });
  }

  async #repository(
    subject: SubjectRevision,
  ): Promise<ReleaseOutstandingWorkSnapshot["repository"]> {
    if (this.scm.getOpenReleaseWork === undefined) {
      return {
        status: "failed",
        bugLabel: "bug",
        bugIssues: [],
        openPullRequests: [],
        gaps: ["SCM reader does not provide open issue/pull request context"],
      };
    }
    try {
      const observed = await this.scm.getOpenReleaseWork(subject.repository);
      return {
        status: observed.complete ? "complete" : "partial",
        bugLabel: "bug",
        bugIssues: observed.bugIssues,
        openPullRequests: observed.openPullRequests.map((pr) => ({
          ...pr,
          candidate: pr.headSha === subject.commitSha,
        })),
        gaps: [...observed.gaps],
      };
    } catch (error) {
      return {
        status: "failed",
        bugLabel: "bug",
        bugIssues: [],
        openPullRequests: [],
        gaps: [`repository work read failed: ${describeError(error)}`],
      };
    }
  }

  async #nightly(repository: string): Promise<ReleaseOutstandingWorkSnapshot["nightly"]> {
    try {
      const snapshot = await this.nightly.forRepository({
        repository,
        limit: NIGHTLY_CONTEXT_REPORT_LIMIT,
      });
      const gaps: string[] = [];
      if (snapshot.reports.length === 0) {
        gaps.push("no durable nightly reports were available for this repository");
      }
      if (snapshot.reports.length > 0 && !snapshot.requiredCoverageComplete) {
        gaps.push(
          `${snapshot.incompleteReports} considered nightly report(s) have incomplete required coverage`,
        );
      }
      if (snapshot.reports.length === NIGHTLY_CONTEXT_REPORT_LIMIT) {
        gaps.push(
          `nightly context is bounded to the newest ${NIGHTLY_CONTEXT_REPORT_LIMIT} reports`,
        );
      }

      const parentIssues = [
        ...new Map(
          snapshot.reports
            .flatMap((report) => (report.parentIssue === null ? [] : [report.parentIssue]))
            .map((issue) => [issue.url, issue] as const),
        ).values(),
      ];

      // Reports are newest-first. The first occurrence of a finding key is the
      // freshest durable lifecycle state; older occurrences must not resurrect
      // work a newer report resolved or dismissed.
      const seen = new Set<string>();
      const findings: ReleaseOutstandingWorkSnapshot["nightly"]["findings"] = [];
      for (const report of snapshot.reports) {
        for (const finding of report.findings) {
          if (seen.has(finding.findingKey)) continue;
          seen.add(finding.findingKey);
          if (finding.visibility !== "surfaced") continue;
          if (finding.resolution !== "open" && finding.resolution !== "awaiting_verification")
            continue;
          findings.push({
            findingKey: finding.findingKey,
            defectClass: finding.defectClass,
            path: finding.path,
            startLine: finding.startLine,
            resolution: finding.resolution,
            issue: finding.issue,
            proposal:
              finding.proposal === null
                ? null
                : {
                    delivery: finding.proposal.delivery,
                    ci: finding.proposal.ci,
                    merge: finding.proposal.merge,
                    pullRequest: finding.proposal.pullRequest,
                    deliveryError: finding.proposal.deliveryError,
                  },
          });
        }
      }
      findings.sort(
        (a, b) =>
          a.path.localeCompare(b.path) ||
          a.startLine - b.startLine ||
          a.findingKey.localeCompare(b.findingKey),
      );

      return {
        status: gaps.length === 0 ? "complete" : "partial",
        reportsConsidered: snapshot.reports.length,
        requiredCoverageComplete: snapshot.requiredCoverageComplete,
        parentIssues,
        findings,
        gaps,
      };
    } catch (error) {
      return {
        status: "failed",
        reportsConsidered: 0,
        requiredCoverageComplete: false,
        parentIssues: [],
        findings: [],
        gaps: [`nightly evidence read failed: ${describeError(error)}`],
      };
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
