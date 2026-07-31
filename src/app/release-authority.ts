import { z } from "zod";
import type { Clock } from "../platform/clock.js";
import type { Scruffy } from "./scruffy.js";
import type { WorkflowApprovalReader } from "../providers/scm/port.js";
import {
  CreateAttestationInput,
  CreateAuthorizationInput,
  ReleaseApprovalAttestation,
  ReleaseShadowAuthorization,
  computeAttestationId,
  computeAuthorizationId,
  sameGithubIdentity,
  type ReleaseApprovalAttestation as ReleaseApprovalAttestationType,
  type ReleaseShadowAuthorization as ReleaseShadowAuthorizationType,
  type WorkflowIdentity,
} from "../domain/release/authority.js";
import {
  ArtifactDigest,
  ReleaseReportSubject,
  TargetEnvironment,
  type ReleaseRiskReport,
} from "../domain/release/report.js";
import {
  ReleaseAuthorityIntegrityError,
  ReleaseAuthorityStore,
  sameEnvelope,
} from "../persistence/release-authority.js";

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
export const HostedReleaseRequest = z.object({
  repository: z.string().min(3),
  candidateSha: Sha,
  previousReleaseSha: Sha.nullable(),
  artifactDigest: ArtifactDigest,
  targetEnvironment: TargetEnvironment,
});
export type HostedReleaseRequest = z.infer<typeof HostedReleaseRequest>;

export class ReleaseAuthorityError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 503,
  ) {
    super(message);
  }
}

export interface ReleaseAuthorityDeps {
  scruffy: Scruffy;
  store: ReleaseAuthorityStore;
  approvals: WorkflowApprovalReader;
  clock: Clock;
  targetEnvironment: string;
  approvalEnvironment: string;
}

export class ReleaseAuthorityService {
  constructor(private readonly deps: ReleaseAuthorityDeps) {}

  get approvalEnvironment(): string {
    return this.deps.approvalEnvironment;
  }

  async requestReport(identity: WorkflowIdentity, raw: unknown): Promise<ReleaseRiskReport> {
    const input = HostedReleaseRequest.parse(raw);
    this.#requireRepository(identity, input.repository);
    if (input.targetEnvironment !== this.deps.targetEnvironment) {
      throw new ReleaseAuthorityError("target environment is not allowlisted", 403);
    }
    const run = await this.deps.scruffy.runRelease({
      repository: input.repository,
      candidate: input.candidateSha,
      prevRelease: input.previousReleaseSha,
      artifactDigest: input.artifactDigest,
      targetEnvironment: input.targetEnvironment,
    });
    const report = await this.deps.store.getReportForRun(run.id);
    if (report === null) {
      throw new ReleaseAuthorityError("release report is not yet available", 409);
    }
    return report;
  }

  async getReport(identity: WorkflowIdentity, reportId: string): Promise<ReleaseRiskReport> {
    const report = await this.deps.store.getCurrentReport(reportId);
    if (report === null) throw new ReleaseAuthorityError("release report not found", 404);
    this.#requireRepository(identity, report.subject.repository);
    if (report.subject.targetEnvironment !== this.deps.targetEnvironment) {
      throw new ReleaseAuthorityError("report target environment is not allowlisted", 403);
    }
    return report;
  }

  async attest(
    identity: WorkflowIdentity,
    reportId: string,
    raw: unknown,
  ): Promise<ReleaseApprovalAttestationType> {
    const input = CreateAttestationInput.parse(raw);
    const report = await this.getReport(identity, reportId);
    if (report.decision.outcome !== "sign-off-required") {
      throw new ReleaseAuthorityError("only sign-off-required reports accept attestations", 409);
    }
    if (
      !input.responsibilityAccepted ||
      !sameGithubIdentity(identity.actor, input.responsibilityAccepter)
    ) {
      throw new ReleaseAuthorityError(
        "responsibility accepter must be the authenticated workflow actor",
        403,
      );
    }

    let history;
    try {
      history = await this.deps.approvals.getWorkflowRunApprovals(
        report.subject.repository,
        identity.runId,
      );
    } catch {
      throw new ReleaseAuthorityError("GitHub approval history is unavailable", 503);
    }
    if (history.runAttempt !== identity.runAttempt) {
      throw new ReleaseAuthorityError("workflow run attempt does not match approval history", 409);
    }
    const approvals = history.approvals.filter(
      (approval) =>
        approval.environment === this.deps.approvalEnvironment && approval.state === "approved",
    );
    const distinctReviewers = new Map(
      approvals.map((approval) => [approval.reviewer.id, approval]),
    );
    if (distinctReviewers.size !== 1) {
      throw new ReleaseAuthorityError("protected-environment approval is absent or ambiguous", 409);
    }
    const approval = [...distinctReviewers.values()][0]!;
    if (new Date(approval.reviewedAt).getTime() < new Date(report.generatedAt).getTime()) {
      throw new ReleaseAuthorityError("protected-environment approval predates the report", 409);
    }
    if (!sameGithubIdentity(identity.actor, approval.reviewer)) {
      throw new ReleaseAuthorityError(
        "authenticated actor is not the protected-environment reviewer",
        403,
      );
    }

    const content = {
      attestationVersion: "1" as const,
      reportId: report.reportId,
      envelope: report.subject,
      approvalEnvironment: this.deps.approvalEnvironment,
      workflow: identity,
      rationale: input.rationale,
      responsibilityAccepted: true as const,
      responsibilityAccepter: input.responsibilityAccepter,
      reviewer: approval.reviewer,
      reviewedAt: approval.reviewedAt,
    };
    const attestation = ReleaseApprovalAttestation.parse({
      ...content,
      attestationId: computeAttestationId(content),
      createdAt: this.deps.clock.now().toISOString(),
    });
    try {
      return await this.deps.store.putAttestation(attestation);
    } catch (error) {
      if (error instanceof ReleaseAuthorityIntegrityError) {
        throw new ReleaseAuthorityError(error.message, 409);
      }
      throw error;
    }
  }

  async authorize(
    identity: WorkflowIdentity,
    reportId: string,
    raw: unknown,
  ): Promise<ReleaseShadowAuthorizationType> {
    const input = CreateAuthorizationInput.parse(raw);
    const report = await this.getReport(identity, reportId);
    if (!sameEnvelope(report.subject, ReleaseReportSubject.parse(input.envelope))) {
      throw new ReleaseAuthorityError("authorization envelope does not match report", 409);
    }
    if (report.decision.outcome === "stop" || report.decision.outcome === "indeterminate") {
      throw new ReleaseAuthorityError(`${report.decision.outcome} reports cannot authorize`, 409);
    }

    const attestationId = input.attestationId ?? null;
    if (report.decision.outcome === "ship" && attestationId !== null) {
      throw new ReleaseAuthorityError("ship authorization must not carry an attestation", 409);
    }
    if (report.decision.outcome === "sign-off-required" && attestationId === null) {
      throw new ReleaseAuthorityError("sign-off authorization requires an attestation", 409);
    }

    const content = {
      authorizationVersion: "1" as const,
      reportId: report.reportId,
      envelope: report.subject,
      outcome: report.decision.outcome,
      attestationId,
      workflow: identity,
      shadowOnly: true as const,
    };
    const authorization = ReleaseShadowAuthorization.parse({
      ...content,
      authorizationId: computeAuthorizationId(content),
      authorizedAt: this.deps.clock.now().toISOString(),
    });
    try {
      return await this.deps.store.putAuthorization(authorization);
    } catch (error) {
      if (error instanceof ReleaseAuthorityIntegrityError) {
        throw new ReleaseAuthorityError(error.message, 409);
      }
      throw error;
    }
  }

  #requireRepository(identity: WorkflowIdentity, repository: string): void {
    if (identity.repository !== repository) {
      throw new ReleaseAuthorityError("OIDC repository does not match release repository", 403);
    }
  }
}
