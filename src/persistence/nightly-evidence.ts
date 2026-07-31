import { AnalysisCoverage } from "../domain/evidence/coverage.js";
import {
  FindingResolution,
  FindingVisibility,
  NightlyReportSummary,
  ProposalCiState,
  ProposalDelivery,
  ProposalMergeState,
  RemediationRecord,
  requiredCoverageGaps,
} from "../domain/findings/work-graph.js";
import type {
  NightlyEvidenceFinding,
  NightlyEvidenceQueryInput,
  NightlyEvidenceReadPort,
  NightlyEvidenceReport,
} from "../domain/findings/nightly-evidence.js";
import type { Pool } from "./db.js";

/**
 * Postgres read model behind `app/nightly-evidence-query.ts`.
 *
 * READ ONLY, on purpose: this class has no insert/update/delete anywhere. It is the
 * one place a later release-report aggregation may look at nightly's durable
 * lifecycle, and it must not become a second writer of it.
 *
 * Every enum and jsonb column is parsed through the domain schema on the way out.
 * These rows drive an operator-facing roll-up, so a half-written or legacy row must
 * fail loudly instead of rendering as "nothing to see" — the same discipline the
 * report/check path already applies.
 */

interface ReportRow {
  report_id: string;
  repository: string;
  branch: string;
  base_sha: string | null;
  head_sha: string;
  policy_version: string;
  required_coverage_complete: boolean;
  coverage: unknown;
  summary: unknown;
  created_at: Date;
  parent_number: number | null;
  parent_url: string | null;
}

interface FindingRow {
  occurrence_id: string;
  finding_key: string;
  rule_id: string;
  defect_class: string;
  path: string;
  start_line: number;
  end_line: number;
  visibility: string;
  visibility_reason: string;
  resolution: string;
  remediation: unknown;
  issue_number: number | null;
  issue_url: string | null;
  proposal_id: string | null;
  delivery: string | null;
  ci: string | null;
  ci_head_sha: string | null;
  merge_state: string | null;
  pr_number: number | null;
  pr_url: string | null;
  delivery_error: string | null;
  dismissed_at: Date | null;
  verification_outcome: string | null;
  verification_detail: string | null;
  verification_subject_sha: string | null;
}

export class NightlyEvidenceStore implements NightlyEvidenceReadPort {
  constructor(private readonly pool: Pool) {}

  async reports(
    input: NightlyEvidenceQueryInput & { limit: number },
  ): Promise<NightlyEvidenceReport[]> {
    const rows = await this.pool.query<ReportRow>(
      `select r.report_id, r.repository, r.branch, r.base_sha, r.head_sha, r.policy_version,
              r.required_coverage_complete, r.coverage, r.summary, r.created_at,
              pub.external_number as parent_number, pub.external_url as parent_url
         from nightly_reports r
         left join nightly_work_items w
                on w.report_id = r.report_id and w.kind = 'nightly_run'
         left join nightly_work_item_publications pub on pub.work_item_id = w.work_item_id
        where r.repository = $1
          and ($2::text is null or r.branch = $2)
          and ($3::text is null or r.head_sha = $3)
        order by r.created_at desc, r.report_id desc
        limit $4`,
      [input.repository, input.branch ?? null, input.candidateSha ?? null, input.limit],
    );

    const reports: NightlyEvidenceReport[] = [];
    for (const row of rows.rows) {
      // Coverage round-trips through jsonb; parsing it here is what stops a legacy or
      // corrupt value from being summarized as complete coverage.
      const coverage = AnalysisCoverage.parse(row.coverage);
      const summary = NightlyReportSummary.parse(row.summary);
      reports.push({
        reportId: row.report_id,
        repository: row.repository,
        branch: row.branch,
        baseSha: row.base_sha,
        headSha: row.head_sha,
        policyVersion: row.policy_version,
        requiredCoverageComplete: row.required_coverage_complete,
        summary: {
          surfaced: summary.surfaced,
          suppressed: summary.suppressed,
          proposals: summary.proposals,
          requiredGaps: summary.requiredGaps,
        },
        // Only REQUIRED gaps: an optional gap is recorded evidence but it does not
        // hold the range open, and mixing the two would misstate coverage.
        coverageGaps: requiredCoverageGaps(coverage).map((gap) => ({
          analyzerId: gap.analyzerId,
          code: gap.code,
          detail: gap.detail,
        })),
        parentIssue:
          row.parent_number === null || row.parent_url === null
            ? null
            : { number: row.parent_number, url: row.parent_url },
        findings: await this.#findings(row.report_id),
        createdAt: row.created_at,
      });
    }
    return reports;
  }

  async #findings(reportId: string): Promise<NightlyEvidenceFinding[]> {
    const rows = await this.pool.query<FindingRow>(
      // The verification join is LATERAL and ordered so the CURRENT answer is the
      // newest immutable subject, never an older, more convenient one.
      `select f.occurrence_id, f.finding_key, f.rule_id, f.defect_class, f.path,
              f.start_line, f.end_line, f.visibility, f.visibility_reason, f.resolution, f.remediation,
              wpub.external_number as issue_number, wpub.external_url as issue_url,
              p.proposal_id, p.delivery, p.ci, p.ci_head_sha, p.merge_state,
              p.pr_number, p.pr_url, p.delivery_error,
              w.dismissed_at,
              v.outcome as verification_outcome, v.detail as verification_detail,
              v.subject_sha as verification_subject_sha
         from nightly_report_findings f
         left join nightly_fix_proposals p on p.occurrence_id = f.occurrence_id
         left join nightly_work_items w on w.occurrence_id = f.occurrence_id
         left join nightly_work_item_publications wpub on wpub.work_item_id = w.work_item_id
         left join lateral (
           select outcome, detail, subject_sha
             from nightly_finding_verifications nv
            where nv.occurrence_id = f.occurrence_id
            order by nv.at desc
            limit 1
         ) v on true
        where f.report_id = $1
        order by f.occurrence_id asc`,
      [reportId],
    );
    return rows.rows.map((row) => toEvidenceFinding(row));
  }
}

function toEvidenceFinding(row: FindingRow): NightlyEvidenceFinding {
  // The stored remediation is the full RemediationRecord (state, reason, proposal);
  // the evidence view exposes only state and reason, and the proposal comes from its
  // own table where the delivery/CI/merge facts actually live.
  const remediation = row.remediation === null ? null : RemediationRecord.parse(row.remediation);
  return {
    occurrenceId: row.occurrence_id,
    findingKey: row.finding_key,
    ruleId: row.rule_id,
    defectClass: row.defect_class,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    visibility: FindingVisibility.parse(row.visibility),
    visibilityReason: row.visibility_reason,
    resolution: FindingResolution.parse(row.resolution),
    issue:
      row.issue_number === null || row.issue_url === null
        ? null
        : { number: row.issue_number, url: row.issue_url },
    remediation:
      remediation === null ? null : { state: remediation.state, reason: remediation.reason },
    proposal:
      row.proposal_id === null
        ? null
        : {
            proposalId: row.proposal_id,
            delivery: ProposalDelivery.parse(row.delivery),
            ci: ProposalCiState.parse(row.ci),
            ciHeadSha: row.ci_head_sha,
            merge: ProposalMergeState.parse(row.merge_state),
            pullRequest:
              row.pr_number === null || row.pr_url === null
                ? null
                : { number: row.pr_number, url: row.pr_url },
            deliveryError: row.delivery_error,
          },
    verification:
      row.verification_outcome === null || row.verification_subject_sha === null
        ? null
        : {
            outcome: row.verification_outcome,
            subjectSha: row.verification_subject_sha,
            detail: row.verification_detail ?? "",
          },
    dismissed: row.dismissed_at !== null,
  };
}
