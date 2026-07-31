import type { Pool, PoolClient } from "./db.js";
import { withTransaction } from "./db.js";
import {
  ReleaseApprovalAttestation,
  ReleaseShadowAuthorization,
  type ReleaseApprovalAttestation as ReleaseApprovalAttestationType,
  type ReleaseShadowAuthorization as ReleaseShadowAuthorizationType,
} from "../domain/release/authority.js";
import {
  parseReleaseReport,
  parseStoredReleaseReport,
  releaseEnvelopeLockKey,
  type ReleaseReportSubject,
  type ReleaseRiskReport,
  type StoredReleaseRiskReport,
} from "../domain/release/report.js";

export class ReleaseAuthorityIntegrityError extends Error {}

export class ReleaseAuthorityStore {
  constructor(private readonly pool: Pool) {}

  async getReport(reportId: string): Promise<StoredReleaseRiskReport | null> {
    const result = await this.pool.query<{ report: unknown }>(
      "select report from release_reports where report_id = $1",
      [reportId],
    );
    const raw = result.rows[0]?.report;
    return raw === undefined ? null : parseStoredReleaseReport(raw);
  }

  async getCurrentReport(reportId: string): Promise<ReleaseRiskReport | null> {
    const stored = await this.getReport(reportId);
    if (stored === null || stored.reportVersion !== "2") return null;
    return parseReleaseReport(stored);
  }

  async getReportForRun(runId: string): Promise<ReleaseRiskReport | null> {
    const result = await this.pool.query<{ report: unknown }>(
      "select report from release_reports where run_id = $1",
      [runId],
    );
    const raw = result.rows[0]?.report;
    return raw === undefined ? null : parseReleaseReport(raw);
  }

  async latestReportForEnvelope(envelope: ReleaseReportSubject): Promise<ReleaseRiskReport | null> {
    const result = await this.pool.query<{ report: unknown }>(
      `select report from release_reports
        where repository = $1 and candidate_sha = $2
          and previous_release_sha is not distinct from $3
          and artifact_digest = $4 and target_environment = $5
        order by authority_seq desc
        limit 1`,
      [
        envelope.repository,
        envelope.candidateSha,
        envelope.previousReleaseSha,
        envelope.artifactDigest,
        envelope.targetEnvironment,
      ],
    );
    const raw = result.rows[0]?.report;
    return raw === undefined ? null : parseReleaseReport(raw);
  }

  async putAttestation(
    attestation: ReleaseApprovalAttestationType,
  ): Promise<ReleaseApprovalAttestationType> {
    const parsed = ReleaseApprovalAttestation.parse(attestation);
    return withTransaction(this.pool, async (client) => {
      await this.#requireCurrentReport(client, parsed.reportId, parsed.envelope);
      await client.query(
        `insert into release_approval_attestations
           (attestation_id, report_id, repository, candidate_sha, artifact_digest,
            target_environment, workflow_run_id, workflow_run_attempt, attestation, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (attestation_id) do nothing`,
        [
          parsed.attestationId,
          parsed.reportId,
          parsed.envelope.repository,
          parsed.envelope.candidateSha,
          parsed.envelope.artifactDigest,
          parsed.envelope.targetEnvironment,
          parsed.workflow.runId,
          parsed.workflow.runAttempt,
          JSON.stringify(parsed),
          parsed.createdAt,
        ],
      );
      const stored = await client.query<{ attestation: unknown }>(
        "select attestation from release_approval_attestations where attestation_id = $1",
        [parsed.attestationId],
      );
      return ReleaseApprovalAttestation.parse(stored.rows[0]!.attestation);
    });
  }

  async getAttestation(attestationId: string): Promise<ReleaseApprovalAttestationType | null> {
    const result = await this.pool.query<{ attestation: unknown }>(
      "select attestation from release_approval_attestations where attestation_id = $1",
      [attestationId],
    );
    const raw = result.rows[0]?.attestation;
    return raw === undefined ? null : ReleaseApprovalAttestation.parse(raw);
  }

  /**
   * The terminal authority transaction. It re-reads the report and exact latest
   * envelope under the same transaction that records authorization, and for an
   * exception also re-reads the attestation. A prior HTTP/body check is never the
   * authority.
   */
  async putAuthorization(
    authorization: ReleaseShadowAuthorizationType,
  ): Promise<ReleaseShadowAuthorizationType> {
    const parsed = ReleaseShadowAuthorization.parse(authorization);
    return withTransaction(this.pool, async (client) => {
      const report = await this.#requireCurrentReport(client, parsed.reportId, parsed.envelope);
      if (report.decision.outcome !== parsed.outcome) {
        throw new ReleaseAuthorityIntegrityError("authorization outcome does not match report");
      }
      if (parsed.outcome === "ship") {
        if (parsed.attestationId !== null) {
          throw new ReleaseAuthorityIntegrityError(
            "ship authorization must not carry an attestation",
          );
        }
      } else {
        if (parsed.attestationId === null) {
          throw new ReleaseAuthorityIntegrityError(
            "sign-off authorization requires an attestation",
          );
        }
        const attestationResult = await client.query<{ attestation: unknown }>(
          "select attestation from release_approval_attestations where attestation_id = $1 for share",
          [parsed.attestationId],
        );
        const raw = attestationResult.rows[0]?.attestation;
        if (raw === undefined) throw new ReleaseAuthorityIntegrityError("attestation not found");
        const attestation = ReleaseApprovalAttestation.parse(raw);
        if (
          attestation.reportId !== parsed.reportId ||
          !sameEnvelope(attestation.envelope, parsed.envelope) ||
          !sameWorkflowIdentity(attestation.workflow, parsed.workflow)
        ) {
          throw new ReleaseAuthorityIntegrityError(
            "attestation does not match report envelope and authorizing workflow identity",
          );
        }
      }

      await client.query(
        `insert into release_shadow_authorizations
           (authorization_id, report_id, attestation_id, repository, candidate_sha,
            artifact_digest, target_environment, workflow_run_id, workflow_run_attempt,
            authorization_record, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (authorization_id) do nothing`,
        [
          parsed.authorizationId,
          parsed.reportId,
          parsed.attestationId,
          parsed.envelope.repository,
          parsed.envelope.candidateSha,
          parsed.envelope.artifactDigest,
          parsed.envelope.targetEnvironment,
          parsed.workflow.runId,
          parsed.workflow.runAttempt,
          JSON.stringify(parsed),
          parsed.authorizedAt,
        ],
      );
      const stored = await client.query<{ authorization: unknown }>(
        "select authorization_record as authorization from release_shadow_authorizations where authorization_id = $1",
        [parsed.authorizationId],
      );
      return ReleaseShadowAuthorization.parse(stored.rows[0]!.authorization);
    });
  }

  async #requireCurrentReport(
    client: PoolClient,
    reportId: string,
    envelope: ReleaseReportSubject,
  ): Promise<ReleaseRiskReport> {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      releaseEnvelopeLockKey(envelope),
    ]);
    const exact = await client.query<{ report: unknown }>(
      "select report from release_reports where report_id = $1 for share",
      [reportId],
    );
    const raw = exact.rows[0]?.report;
    if (raw === undefined) throw new ReleaseAuthorityIntegrityError("report not found");
    const report = parseReleaseReport(raw);
    if (!sameEnvelope(report.subject, envelope)) {
      throw new ReleaseAuthorityIntegrityError("report envelope mismatch");
    }
    const latest = await client.query<{ report_id: string }>(
      `select report_id from release_reports
        where repository = $1 and candidate_sha = $2
          and previous_release_sha is not distinct from $3
          and artifact_digest = $4 and target_environment = $5
        order by authority_seq desc
        limit 1
        for share`,
      [
        envelope.repository,
        envelope.candidateSha,
        envelope.previousReleaseSha,
        envelope.artifactDigest,
        envelope.targetEnvironment,
      ],
    );
    if (latest.rows[0]?.report_id !== reportId) {
      throw new ReleaseAuthorityIntegrityError("report has been superseded for this envelope");
    }
    return report;
  }
}

function sameWorkflowIdentity(
  left: ReleaseApprovalAttestationType["workflow"],
  right: ReleaseShadowAuthorizationType["workflow"],
): boolean {
  return (
    left.issuer === right.issuer &&
    left.audience === right.audience &&
    left.repository === right.repository &&
    left.repositoryId === right.repositoryId &&
    left.workflowRef === right.workflowRef &&
    left.runId === right.runId &&
    left.runAttempt === right.runAttempt &&
    left.actor.id === right.actor.id &&
    left.actor.login.toLowerCase() === right.actor.login.toLowerCase() &&
    left.environment === right.environment
  );
}

export function sameEnvelope(left: ReleaseReportSubject, right: ReleaseReportSubject): boolean {
  return (
    left.repository === right.repository &&
    left.previousReleaseSha === right.previousReleaseSha &&
    left.candidateSha === right.candidateSha &&
    left.artifactDigest === right.artifactDigest &&
    left.targetEnvironment === right.targetEnvironment
  );
}
