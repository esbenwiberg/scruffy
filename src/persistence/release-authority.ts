import type { Pool, PoolClient } from "./db.js";
import { withTransaction } from "./db.js";
import {
  ReleaseApprovalAttestation,
  ReleaseReportRequestObservation,
  ReleaseShadowAuthorization,
  StoredReleaseApprovalAttestation,
  type ReleaseApprovalAttestation as ReleaseApprovalAttestationType,
  type ReleaseReportRequestObservation as ReleaseReportRequestObservationType,
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

  /**
   * Durably record that the current workflow attempt requested THIS report, BEFORE
   * the report is returned to the caller. An exact retry converges on the original
   * row (idempotent, first observation time wins); a divergent observation for the
   * same natural key surfaces as a conflict and fails closed rather than returning an
   * unrelated row.
   */
  async putReportRequest(
    observation: ReleaseReportRequestObservationType,
  ): Promise<ReleaseReportRequestObservationType> {
    const parsed = ReleaseReportRequestObservation.parse(observation);
    return withTransaction(this.pool, async (client) => {
      await this.#requireCurrentReport(client, parsed.reportId, parsed.envelope);
      try {
        await client.query(
          `insert into release_report_requests
             (request_id, report_id, repository, candidate_sha, artifact_digest,
              target_environment, workflow_ref, workflow_run_id, workflow_run_attempt,
              observation, observed_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           on conflict (request_id) do nothing`,
          [
            parsed.requestId,
            parsed.reportId,
            parsed.envelope.repository,
            parsed.envelope.candidateSha,
            parsed.envelope.artifactDigest,
            parsed.envelope.targetEnvironment,
            parsed.workflowRef,
            parsed.runId,
            parsed.runAttempt,
            JSON.stringify(parsed),
            parsed.observedAt,
          ],
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ReleaseAuthorityIntegrityError(
            "a conflicting report-request observation already exists for this workflow attempt",
          );
        }
        throw error;
      }
      const stored = await client.query<{ observation: unknown }>(
        "select observation from release_report_requests where request_id = $1",
        [parsed.requestId],
      );
      return ReleaseReportRequestObservation.parse(stored.rows[0]!.observation);
    });
  }

  async getReportRequest(
    requestId: string,
  ): Promise<ReleaseReportRequestObservationType | null> {
    const result = await this.pool.query<{ observation: unknown }>(
      "select observation from release_report_requests where request_id = $1",
      [requestId],
    );
    const raw = result.rows[0]?.observation;
    return raw === undefined ? null : ReleaseReportRequestObservation.parse(raw);
  }

  async putAttestation(
    attestation: ReleaseApprovalAttestationType,
  ): Promise<ReleaseApprovalAttestationType> {
    const parsed = ReleaseApprovalAttestation.parse(attestation);
    return withTransaction(this.pool, async (client) => {
      await this.#requireCurrentReport(client, parsed.reportId, parsed.envelope);
      await client.query(
        `insert into release_approval_attestations
           (attestation_id, attestation_version, report_id, repository, candidate_sha,
            artifact_digest, target_environment, workflow_run_id, workflow_run_attempt,
            attestation, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (attestation_id) do nothing`,
        [
          parsed.attestationId,
          parsed.attestationVersion,
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

  /**
   * Audit read: returns either historical v1 or active v2 attestation data. Callers
   * that authorize must additionally require v2 (see putAuthorization).
   */
  async getAttestation(
    attestationId: string,
  ): Promise<StoredReleaseApprovalAttestation | null> {
    const result = await this.pool.query<{ attestation: unknown }>(
      "select attestation from release_approval_attestations where attestation_id = $1",
      [attestationId],
    );
    const raw = result.rows[0]?.attestation;
    return raw === undefined ? null : StoredReleaseApprovalAttestation.parse(raw);
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
        const stored = StoredReleaseApprovalAttestation.parse(raw);
        // Historical v1 attestations remain audit-readable but can never authorize
        // under the current contract — they lack a durable ordering binding.
        if (stored.attestationVersion !== "2") {
          throw new ReleaseAuthorityIntegrityError(
            "attestation version is ineligible for terminal authorization",
          );
        }
        const attestation = stored;
        if (
          attestation.reportId !== parsed.reportId ||
          !sameEnvelope(attestation.envelope, parsed.envelope) ||
          !sameWorkflowIdentity(attestation.workflow, parsed.workflow)
        ) {
          throw new ReleaseAuthorityIntegrityError(
            "attestation does not match report envelope and authorizing workflow identity",
          );
        }
        // Terminal ordering revalidation: the durable report-request observation the
        // attestation binds to must still exist and match the exact report, envelope,
        // pinned workflow ref, run, and attempt. Removal or mutation refuses.
        const requestResult = await client.query<{ observation: unknown }>(
          "select observation from release_report_requests where request_id = $1 for share",
          [attestation.requestObservationId],
        );
        const requestRaw = requestResult.rows[0]?.observation;
        if (requestRaw === undefined) {
          throw new ReleaseAuthorityIntegrityError("report-request observation not found");
        }
        const observation = ReleaseReportRequestObservation.parse(requestRaw);
        if (
          observation.reportId !== parsed.reportId ||
          !sameEnvelope(observation.envelope, parsed.envelope) ||
          observation.workflowRef !== parsed.workflow.workflowRef ||
          observation.runId !== parsed.workflow.runId ||
          observation.runAttempt !== parsed.workflow.runAttempt
        ) {
          throw new ReleaseAuthorityIntegrityError(
            "report-request observation does not match the authorizing workflow ordering",
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

/** Postgres unique-violation SQLSTATE, so a concurrent conflict fails closed cleanly. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
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
