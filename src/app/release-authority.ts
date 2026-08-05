import { z } from "zod";
import type { Clock } from "../platform/clock.js";
import type { Scruffy } from "./scruffy.js";
import type {
  ScmReader,
  WorkflowApprovalReader,
  WorkflowRunReader,
} from "../providers/scm/port.js";
import {
  resolveReleasePrerequisites,
  type ResolvedReleasePrerequisites,
} from "../gates/release/prerequisites.js";
import type { ReleaseReasonCode } from "../gates/release/decision.js";
import {
  CreateAttestationInput,
  CreateAuthorizationInput,
  ReleaseApprovalAttestation,
  ReleaseReportRequestObservation,
  ReleaseShadowAuthorization,
  computeAttestationId,
  computeAuthorizationId,
  computeReportRequestId,
  sameGithubIdentity,
  type ReleaseApprovalAttestation as ReleaseApprovalAttestationType,
  type ReleaseShadowAuthorization as ReleaseShadowAuthorizationType,
  type WorkflowIdentity,
} from "../domain/release/authority.js";
import {
  ArtifactDigest,
  ReleaseReportSubject,
  TargetEnvironment,
  isPrerequisiteAuthoritative,
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
  /**
   * Whether the caller should retry the SAME request. Only true for a still-pending
   * prerequisite (evidence that is not a result yet); false for every fail-closed or
   * mismatch case, where the caller must request a FRESH report instead of re-asking.
   */
  readonly retryable: boolean;
  /** Stable prerequisite reason codes, surfaced so a caller can distinguish causes. */
  readonly reasonCodes: readonly ReleaseReasonCode[];

  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 503,
    options: { retryable?: boolean; reasonCodes?: readonly ReleaseReasonCode[] } = {},
  ) {
    super(message);
    this.retryable = options.retryable ?? false;
    this.reasonCodes = options.reasonCodes ?? [];
  }
}

export interface ReleaseAuthorityDeps {
  scruffy: Scruffy;
  store: ReleaseAuthorityStore;
  approvals: WorkflowApprovalReader;
  clock: Clock;
  targetEnvironment: string;
  approvalEnvironment: string;
  /**
   * Exact-SHA source reader used to read the repository release configuration and the
   * authority-path change set. Required together with `workflowRuns` to make the service
   * prerequisite-aware; absent leaves it on the legacy context-based candidate-CI path.
   */
  scm?: ScmReader;
  /**
   * Narrow read-only Actions capability that resolves exact required-workflow run
   * evidence. When wired (with `scm`) the service resolves repository-owned workflow
   * prerequisites before returning an approvable report and revalidates them before
   * authorization. Absent = the legacy v2 path, unchanged.
   */
  workflowRuns?: WorkflowRunReader;
}

export class ReleaseAuthorityService {
  constructor(private readonly deps: ReleaseAuthorityDeps) {}

  get approvalEnvironment(): string {
    return this.deps.approvalEnvironment;
  }

  /**
   * True when the service is wired to resolve repository-owned workflow prerequisites
   * (both the exact-SHA source reader and the read-only Actions run reader). When true,
   * EVERY report this service hands out for approval or authorization MUST be
   * prerequisite-authoritative (v3): a non-v3 report means its durable run was decided
   * WITHOUT resolving prerequisites — e.g. the background reconciler drove it with no
   * prerequisite context — and returning/authorizing it would silently bypass the
   * fail-closed workflow lane. Such a report is refused (fail closed).
   */
  get #prerequisiteAware(): boolean {
    return this.deps.scm !== undefined && this.deps.workflowRuns !== undefined;
  }

  /**
   * A prerequisite-aware service refuses any report that is not prerequisite-
   * authoritative (v3 with a snapshot). This is the single guard that stops a v2 report
   * — one decided without resolving repository workflow prerequisites — from entering
   * approval or authorization, where it would otherwise skip the fail-closed workflow
   * lane and the authorization-time freshness revalidation. A legacy (non-aware) service
   * is unaffected: its v2 reports remain approvable exactly as before.
   */
  #requirePrerequisiteAuthoritative(report: ReleaseRiskReport): void {
    if (this.#prerequisiteAware && !isPrerequisiteAuthoritative(report)) {
      throw new ReleaseAuthorityError(
        "release report was not resolved against repository workflow prerequisites; request a fresh report",
        409,
      );
    }
  }

  async requestReport(identity: WorkflowIdentity, raw: unknown): Promise<ReleaseRiskReport> {
    const input = HostedReleaseRequest.parse(raw);
    this.#requireRepository(identity, input.repository);
    // The report request is the PRE-approval step. A token that already carries a
    // protected-Environment claim belongs to the attestation gate, not here — reject
    // it rather than accepting it as the pre-approval observation.
    if (identity.environment !== null) {
      throw new ReleaseAuthorityError(
        "report request must not carry a protected Environment claim",
        403,
      );
    }
    if (input.targetEnvironment !== this.deps.targetEnvironment) {
      throw new ReleaseAuthorityError("target environment is not allowlisted", 403);
    }
    // Resolve the repository-owned workflow prerequisites (config, authority change, and
    // exact current workflow evidence) BEFORE the run is ensured — the evidence digest is
    // part of release-run identity, so a changed attempt/config/authority yields a
    // successor run and report. Undefined on the legacy (non-prerequisite-aware) path.
    const prerequisite = await this.#resolvePrerequisites({
      repository: input.repository,
      candidateSha: input.candidateSha,
      previousReleaseSha: input.previousReleaseSha,
    });
    const run = await this.deps.scruffy.runRelease({
      repository: input.repository,
      candidate: input.candidateSha,
      prevRelease: input.previousReleaseSha,
      artifactDigest: input.artifactDigest,
      targetEnvironment: input.targetEnvironment,
      ...(prerequisite !== undefined ? { prerequisite } : {}),
    });
    const report = await this.deps.store.getReportForRun(run.id);
    if (report === null) {
      throw new ReleaseAuthorityError("release report is not yet available", 409);
    }
    // Fail closed if a prerequisite-aware request deduped onto a run that was decided
    // WITHOUT resolving prerequisites (a non-v3 report). The run's evidence digest is
    // part of its identity, so a decided run can carry a v2 report only when something
    // other than this path (the reconciler, with no prerequisite context) drove it.
    // Returning it would bypass the whole workflow lane, so refuse before it can be
    // recorded or approved.
    this.#requirePrerequisiteAuthoritative(report);
    // A not-approvable prerequisite (pending / absent / unverifiable / ineligible
    // configuration) resolves to an `indeterminate` decision: the durable report exists
    // (successor semantics) but it can neither ship nor enter the approval Environment.
    // It records NO report-request observation — approval ordering must never begin for
    // evidence that is not a result. Pending is retryable; everything else is fail-closed
    // and requires a fresh report once the evidence becomes a result.
    if (prerequisite !== undefined && report.decision.outcome === "indeterminate") {
      if (prerequisite.state.kind === "not-approvable") {
        // Retryable ONLY when the workflow aggregate is genuinely not-ready (something is
        // still pending and nothing is fail-closed). The aggregate's conservative
        // precedence already collapses a mixed pending+absent/unverifiable set to a
        // fail-closed outcome, so keying on it — rather than scanning reasons — can never
        // report a fail-closed prerequisite as retryable. An ineligible configuration
        // (fail-closed aggregate) is likewise non-retryable.
        const retryable = prerequisite.aggregate.outcome === "not-ready";
        throw new ReleaseAuthorityError(
          retryable
            ? "release prerequisites are still pending; retry once the required workflows complete"
            : "release prerequisites cannot be approved; request a fresh report",
          409,
          { retryable, reasonCodes: prerequisite.state.reasons },
        );
      }
      // A prerequisite-aware run that abstained for an infrastructure reason (not a
      // prerequisite result) is a service-side gap, not a caller-fixable state.
      throw new ReleaseAuthorityError("release analysis could not be completed", 503);
    }
    // Persist THIS workflow attempt's exact request observation BEFORE returning the
    // report. The report may pre-exist from an earlier idempotent analysis, so the
    // durable ordering proof must be recorded here, not inferred later.
    await this.#recordReportRequest(identity, report);
    return report;
  }

  /**
   * Resolve prerequisites when the service is prerequisite-aware (both `scm` and
   * `workflowRuns` wired), else undefined so the legacy v2 candidate-CI path is
   * unchanged. Shared by report creation and authorization revalidation so the two can
   * never resolve evidence differently.
   */
  async #resolvePrerequisites(range: {
    repository: string;
    candidateSha: string;
    previousReleaseSha: string | null;
  }): Promise<ResolvedReleasePrerequisites | undefined> {
    const { scm, workflowRuns } = this.deps;
    if (scm === undefined || workflowRuns === undefined) return undefined;
    return resolveReleasePrerequisites(range, { scm, workflowRuns });
  }

  async #recordReportRequest(identity: WorkflowIdentity, report: ReleaseRiskReport): Promise<void> {
    const content = {
      requestVersion: "1" as const,
      reportId: report.reportId,
      envelope: report.subject,
      workflowRef: identity.workflowRef,
      runId: identity.runId,
      runAttempt: identity.runAttempt,
      ...(report.prerequisite !== undefined
        ? { prereqEvidenceDigest: report.prerequisite.evidenceDigest }
        : {}),
    };
    const observation = ReleaseReportRequestObservation.parse({
      ...content,
      requestId: computeReportRequestId(content),
      observedAt: this.deps.clock.now().toISOString(),
    });
    try {
      await this.deps.store.putReportRequest(observation);
    } catch (error) {
      if (error instanceof ReleaseAuthorityIntegrityError) {
        throw new ReleaseAuthorityError(error.message, 409);
      }
      throw error;
    }
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
    // A prerequisite-aware service never attests a report that never resolved workflow
    // prerequisites — the same fail-closed guard requestReport and authorize apply.
    this.#requirePrerequisiteAuthoritative(report);
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

    // Same-run ordering proof: a durable prior report-request observation must bind
    // THIS exact report, envelope, pinned workflow ref, run, and attempt. A report
    // that merely pre-exists is not enough — the attesting attempt must have recorded
    // its own request first.
    const requestContent = {
      requestVersion: "1" as const,
      reportId: report.reportId,
      envelope: report.subject,
      workflowRef: identity.workflowRef,
      runId: identity.runId,
      runAttempt: identity.runAttempt,
      ...(report.prerequisite !== undefined
        ? { prereqEvidenceDigest: report.prerequisite.evidenceDigest }
        : {}),
    };
    const observation = await this.deps.store.getReportRequest(
      computeReportRequestId(requestContent),
    );
    if (observation === null) {
      throw new ReleaseAuthorityError(
        "no durable report request precedes this approval in the same workflow attempt",
        409,
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
    // Only an unambiguous `approved` reviewer for the configured protected Environment
    // supports attestation. `pending`/`rejected` entries are represented honestly and
    // simply do not count as approvals.
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
    if (!sameGithubIdentity(identity.actor, approval.reviewer)) {
      throw new ReleaseAuthorityError(
        "authenticated actor is not the protected-environment reviewer",
        403,
      );
    }

    // GitHub supplies no review timestamp; provenance records the service-owned
    // verification instead of inventing one.
    const verifiedAt = this.deps.clock.now().toISOString();
    const content = {
      attestationVersion: "2" as const,
      reportId: report.reportId,
      envelope: report.subject,
      approvalEnvironment: this.deps.approvalEnvironment,
      workflow: identity,
      requestObservationId: observation.requestId,
      rationale: input.rationale,
      responsibilityAccepted: true as const,
      responsibilityAccepter: input.responsibilityAccepter,
      reviewer: approval.reviewer,
      // Bind the exact prerequisite evidence snapshot into the attestation so it can be
      // audited and can never carry forward onto a successor report's evidence.
      ...(report.prerequisite !== undefined
        ? { prereqEvidenceDigest: report.prerequisite.evidenceDigest }
        : {}),
      verificationProvenance: {
        source: "github-actions-approval-history" as const,
        approvalState: "approved" as const,
        runAttempt: identity.runAttempt,
      },
    };
    const attestation = ReleaseApprovalAttestation.parse({
      ...content,
      attestationId: computeAttestationId(content),
      approvalVerifiedAt: verifiedAt,
      createdAt: verifiedAt,
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
    // A prerequisite-aware service never authorizes a report that never resolved workflow
    // prerequisites (a v2 report decided without a prerequisite snapshot); doing so would
    // skip the freshness revalidation below and the fail-closed workflow lane entirely.
    this.#requirePrerequisiteAuthoritative(report);
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

    // Immediately before persistence — for BOTH ship and sign-off — re-fetch candidate
    // configuration and every current workflow run/attempt, canonicalize the fresh
    // snapshot, and require exact equality with the report's evidence digest. A newer
    // attempt, a pending rerun, a changed conclusion, a changed authority file, an
    // identity mismatch, or a provider fault all change (or cannot reproduce) the digest
    // and refuse the authorization — the caller must request a fresh report. The durable
    // latest-report Postgres fence in the store remains the final authority check.
    const prereqDigest = await this.#revalidatePrerequisites(report);

    const content = {
      authorizationVersion: "1" as const,
      reportId: report.reportId,
      envelope: report.subject,
      outcome: report.decision.outcome,
      attestationId,
      workflow: identity,
      ...(prereqDigest !== null ? { prereqEvidenceDigest: prereqDigest } : {}),
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

  /**
   * Re-read fresh prerequisite evidence and require it to exactly reproduce the report's
   * bound evidence digest. Returns the digest to record on the authorization, or null for
   * a legacy v2 report (no prerequisite authority). A prerequisite-authoritative report
   * that cannot be revalidated (deps missing) or whose evidence changed refuses.
   */
  async #revalidatePrerequisites(report: ReleaseRiskReport): Promise<string | null> {
    if (!isPrerequisiteAuthoritative(report) || report.prerequisite === undefined) return null;
    const fresh = await this.#resolvePrerequisites({
      repository: report.subject.repository,
      candidateSha: report.subject.candidateSha,
      previousReleaseSha: report.subject.previousReleaseSha,
    });
    if (fresh === undefined) {
      throw new ReleaseAuthorityError(
        "release prerequisites cannot be revalidated for this authorization",
        409,
      );
    }
    if (fresh.snapshot.evidenceDigest !== report.prerequisite.evidenceDigest) {
      throw new ReleaseAuthorityError(
        "release prerequisite evidence changed since the report; request a fresh report",
        409,
        {
          reasonCodes:
            fresh.state.kind === "not-approvable" || fresh.state.kind === "sign-off"
              ? fresh.state.reasons
              : [],
        },
      );
    }
    return report.prerequisite.evidenceDigest;
  }

  #requireRepository(identity: WorkflowIdentity, repository: string): void {
    if (identity.repository !== repository) {
      throw new ReleaseAuthorityError("OIDC repository does not match release repository", 403);
    }
  }
}
