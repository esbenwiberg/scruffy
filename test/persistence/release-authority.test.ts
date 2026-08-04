import { afterEach, expect, it } from "vitest";
import { describeDb } from "../support/db.js";
import { bootHarness, type Harness } from "../harness/boot.js";
import { REPO } from "../fixtures/scenarios.js";
import {
  ReleaseAuthorityStore,
  ReleaseAuthorityIntegrityError,
} from "../../src/persistence/release-authority.js";
import {
  ReleaseApprovalAttestation,
  ReleaseReportRequestObservation,
  ReleaseShadowAuthorization,
  computeAttestationId,
  computeAuthorizationId,
  computeReportRequestId,
  type ReleaseReportRequestObservation as ReleaseReportRequestObservationType,
  type WorkflowIdentity,
} from "../../src/domain/release/authority.js";
import {
  assembleReleaseReport,
  type ReleaseRiskReport,
} from "../../src/domain/release/report.js";
import {
  buildPrerequisiteSnapshot,
  type ReleasePrerequisiteSnapshot,
} from "../../src/domain/release/prerequisite-snapshot.js";
import { COMPLETE_COVERAGE } from "../../src/domain/evidence/coverage.js";
import type { ReleaseDecision } from "../../src/gates/release/decision.js";
import type { ReleaseAuthorityAssessment } from "../../src/domain/release/authority-change.js";
import type {
  RequiredWorkflowAggregate,
  RequiredWorkflowEvidence,
} from "../../src/domain/release/required-workflow-evidence.js";

const PREV = "a1".repeat(20);
const CAND = "b2".repeat(20);
const OTHER_CAND = "c3".repeat(20);
const ARTIFACT = `sha256:${"d4".repeat(32)}`;
const ENV = "shadow-production";
const POLICY_VERSION = "policy-v1";
const APPROVAL_ENVIRONMENT = "scruffy-production-signoff";
const WORKFLOW_REF = "acme/control/.github/workflows/release.yml@deadbeef";
const identity: WorkflowIdentity = {
  issuer: "https://token.actions.githubusercontent.com",
  audience: "scruffy-release",
  repository: REPO,
  repositoryId: "123",
  workflowRef: WORKFLOW_REF,
  runId: "456",
  runAttempt: 1,
  actor: { login: "owner", id: "789" },
  environment: APPROVAL_ENVIRONMENT,
};
let h: Harness;

afterEach(async () => h?.pool.end());

function seedSignoffFiles(candidate: string) {
  h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: candidate }, [
    { path: "src/http.ts", patch: "@@ -0,0 +1 @@\n+const x = { rejectUnauthorized: false };" },
  ]);
}

async function signoffReport(candidate: string): Promise<ReleaseRiskReport> {
  seedSignoffFiles(candidate);
  const run = await h.scruffy.runRelease({
    repository: REPO,
    candidate,
    prevRelease: PREV,
    artifactDigest: ARTIFACT,
    targetEnvironment: "shadow-production",
  });
  const store = new ReleaseAuthorityStore(h.pool);
  const report = (await store.getReportForRun(run.id))!;
  expect(report.decision.outcome).toBe("sign-off-required");
  return report;
}

function observationFor(
  report: ReleaseRiskReport,
  overrides: Partial<Pick<WorkflowIdentity, "workflowRef" | "runId" | "runAttempt">> = {},
  observedAt = "2026-07-15T00:00:00.000Z",
): ReleaseReportRequestObservationType {
  const content = {
    requestVersion: "1" as const,
    reportId: report.reportId,
    envelope: report.subject,
    workflowRef: overrides.workflowRef ?? identity.workflowRef,
    runId: overrides.runId ?? identity.runId,
    runAttempt: overrides.runAttempt ?? identity.runAttempt,
  };
  return ReleaseReportRequestObservation.parse({
    ...content,
    requestId: computeReportRequestId(content),
    observedAt,
  });
}

function attestationFor(
  report: ReleaseRiskReport,
  requestObservationId: string,
  workflow: WorkflowIdentity = identity,
) {
  const content = {
    attestationVersion: "2" as const,
    reportId: report.reportId,
    envelope: report.subject,
    approvalEnvironment: APPROVAL_ENVIRONMENT,
    workflow,
    requestObservationId,
    rationale: "Controlled exception",
    responsibilityAccepted: true as const,
    responsibilityAccepter: workflow.actor,
    reviewer: workflow.actor,
    verificationProvenance: {
      source: "github-actions-approval-history" as const,
      approvalState: "approved" as const,
      runAttempt: workflow.runAttempt,
    },
  };
  return ReleaseApprovalAttestation.parse({
    ...content,
    attestationId: computeAttestationId(content),
    approvalVerifiedAt: "2026-07-15T00:00:00.000Z",
    createdAt: "2026-07-15T00:00:00.000Z",
  });
}

function authorizationFor(
  report: ReleaseRiskReport,
  attestationId: string,
  workflow: WorkflowIdentity = identity,
) {
  const content = {
    authorizationVersion: "1" as const,
    reportId: report.reportId,
    envelope: report.subject,
    outcome: "sign-off-required" as const,
    attestationId,
    workflow,
    shadowOnly: true as const,
  };
  return ReleaseShadowAuthorization.parse({
    ...content,
    authorizationId: computeAuthorizationId(content),
    authorizedAt: "2026-07-15T00:00:00.000Z",
  });
}

async function count(table: string): Promise<string> {
  const result = await h.pool.query<{ count: string }>(`select count(*) from ${table}`);
  return result.rows[0]!.count;
}

// ── v3 prerequisite-aware report/authorization builders ─────────────────────────

const SHIP: ReleaseDecision = {
  outcome: "ship",
  reasons: ["no_release_findings"],
  dispositions: [],
  summary: { stopped: 0, escalated: 0, cleared: 0, notRelevant: 0 },
  coverage: COMPLETE_COVERAGE,
};

function wfEvidence(over: Partial<RequiredWorkflowEvidence> = {}): RequiredWorkflowEvidence {
  return {
    workflowId: 7,
    workflowPath: ".github/workflows/ci.yml",
    runId: 100,
    runAttempt: 1,
    event: "push",
    branch: "main",
    candidateSha: CAND,
    status: "completed",
    conclusion: "success",
    url: `https://github.com/${REPO}/actions/runs/100`,
    ...over,
  };
}

function cleanAuthority(): ReleaseAuthorityAssessment {
  const cfg = { version: 1 as const, requiredWorkflows: [".github/workflows/ci.yml"] };
  return {
    outcome: "clean",
    reasonCode: "authority_unchanged",
    firstAdoption: false,
    configChanged: false,
    changedAuthorityPaths: [],
    addedRequiredWorkflows: [],
    removedRequiredWorkflows: [],
    candidate: { config: cfg, digest: "cfg-a" },
    previous: { config: cfg, digest: "cfg-a" },
    detail: "",
  };
}

function passedAggregate(ev: RequiredWorkflowEvidence): RequiredWorkflowAggregate {
  return {
    outcome: "satisfied",
    reasonCode: "required_workflows_satisfied",
    workflows: [{ workflowPath: ev.workflowPath, state: "passed", evidence: ev }],
  };
}

function shipReport(snapshot: ReleasePrerequisiteSnapshot): ReleaseRiskReport {
  return assembleReleaseReport({
    subject: {
      repository: REPO,
      previousReleaseSha: PREV,
      candidateSha: CAND,
      artifactDigest: ARTIFACT,
      targetEnvironment: ENV,
    },
    policyVersion: POLICY_VERSION,
    generatedAt: "2026-07-15T00:00:00.000Z",
    provenance: { analyzers: [{ id: "secret-scan" }] },
    findings: [],
    decision: SHIP,
    prerequisite: snapshot,
  });
}

async function persistShip(report: ReleaseRiskReport, digest: string): Promise<void> {
  const run = await h.scruffy.runs.ensureReleaseRun(
    { repository: REPO, commitSha: CAND },
    PREV,
    ARTIFACT,
    ENV,
    POLICY_VERSION,
    digest,
  );
  if (run.state !== "pending") return; // a dedup retry needs no re-commit
  const lease = await h.scruffy.runs.claimForAnalysis(run.id, "test", 60_000);
  await h.scruffy.runs.commitReleaseDecision({
    runId: run.id,
    from: "analyzing",
    to: "decided",
    reason: "release ship",
    decision: SHIP,
    report,
    findings: [],
    fenceLease: lease!,
  });
}

function shipAuthorization(report: ReleaseRiskReport, digest: string) {
  const content = {
    authorizationVersion: "1" as const,
    reportId: report.reportId,
    envelope: report.subject,
    outcome: "ship" as const,
    attestationId: null,
    workflow: identity,
    prereqEvidenceDigest: digest,
    shadowOnly: true as const,
  };
  return ReleaseShadowAuthorization.parse({
    ...content,
    authorizationId: computeAuthorizationId(content),
    authorizedAt: "2026-07-15T00:00:00.000Z",
  });
}

describeDb("report request observation idempotency", () => {
  it("persists report request observations idempotently", async () => {
    h = await bootHarness({ publishReleaseCheck: false });
    const report = await signoffReport(CAND);
    const store = new ReleaseAuthorityStore(h.pool);

    const observation = observationFor(report);
    const first = await store.putReportRequest(observation);
    expect(first).toEqual(observation);

    // Exact retry (even with a different service-observed time) converges on the
    // ORIGINAL row rather than duplicating or overwriting it.
    const retry = observationFor(report, {}, "2026-07-15T09:30:00.000Z");
    const second = await store.putReportRequest(retry);
    expect(second.requestId).toBe(observation.requestId);
    expect(second.observedAt).toBe(observation.observedAt);
    expect(await count("release_report_requests")).toBe("1");

    // A neighbouring run/attempt for the same report is a DISTINCT observation.
    await store.putReportRequest(observationFor(report, { runAttempt: 2 }));
    await store.putReportRequest(observationFor(report, { runId: "789" }));
    expect(await count("release_report_requests")).toBe("3");

    // A neighbouring report (different candidate) never collides either.
    const otherReport = await signoffReport(OTHER_CAND);
    await store.putReportRequest(observationFor(otherReport));
    expect(await count("release_report_requests")).toBe("4");

    // The exact observation is retrievable and re-parses through the runtime schema.
    const fetched = await store.getReportRequest(observation.requestId);
    expect(fetched).toEqual(observation);
    expect(await store.getReportRequest(`rrq_${"0".repeat(64)}`)).toBeNull();
  });
});

describeDb("terminal ordering revalidation", () => {
  it("terminally revalidates report request and attestation ordering", async () => {
    h = await bootHarness({ publishReleaseCheck: false });
    const report = await signoffReport(CAND);
    const store = new ReleaseAuthorityStore(h.pool);

    const observation = observationFor(report);
    await store.putReportRequest(observation);
    const attestation = attestationFor(report, observation.requestId);
    await store.putAttestation(attestation);

    // Wrong run/attempt in the authorizing identity → refuse, commit nothing.
    await expect(
      store.putAuthorization(
        authorizationFor(report, attestation.attestationId, { ...identity, runId: "999" }),
      ),
    ).rejects.toBeInstanceOf(ReleaseAuthorityIntegrityError);
    expect(await count("release_shadow_authorizations")).toBe("0");

    // A historical v1 attestation is audit-readable but INELIGIBLE for terminal
    // authorization. Insert one directly (a distinct run attempt to avoid the exact
    // uniqueness index) and prove it cannot authorize.
    const v1Id = `ra_${"1".repeat(64)}`;
    await h.pool.query(
      `insert into release_approval_attestations
         (attestation_id, attestation_version, report_id, repository, candidate_sha,
          artifact_digest, target_environment, workflow_run_id, workflow_run_attempt,
          attestation, created_at)
       values ($1, '1', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        v1Id,
        report.reportId,
        report.subject.repository,
        report.subject.candidateSha,
        report.subject.artifactDigest,
        report.subject.targetEnvironment,
        identity.runId,
        2,
        JSON.stringify({
          attestationVersion: "1",
          attestationId: v1Id,
          reportId: report.reportId,
          envelope: report.subject,
          approvalEnvironment: APPROVAL_ENVIRONMENT,
          workflow: { ...identity, runAttempt: 2 },
          rationale: "legacy",
          responsibilityAccepted: true,
          responsibilityAccepter: identity.actor,
          reviewer: identity.actor,
          reviewedAt: "2026-07-15T00:00:00.000Z",
          createdAt: "2026-07-15T00:00:00.000Z",
        }),
        "2026-07-15T00:00:00.000Z",
      ],
    );
    await expect(
      store.putAuthorization(authorizationFor(report, v1Id, { ...identity, runAttempt: 2 })),
    ).rejects.toThrow(/ineligible/);
    expect(await count("release_shadow_authorizations")).toBe("0");

    // Remove the durable request observation → terminal revalidation refuses.
    await h.pool.query("delete from release_report_requests where request_id = $1", [
      observation.requestId,
    ]);
    await expect(
      store.putAuthorization(authorizationFor(report, attestation.attestationId)),
    ).rejects.toThrow(/report-request observation not found/);
    expect(await count("release_shadow_authorizations")).toBe("0");

    // Restore the observation → the exact terminal authorization now commits.
    await store.putReportRequest(observation);
    const authorization = authorizationFor(report, attestation.attestationId);
    await expect(store.putAuthorization(authorization)).resolves.toMatchObject({
      outcome: "sign-off-required",
      shadowOnly: true,
    });
    expect(await count("release_shadow_authorizations")).toBe("1");
    // Idempotent replay returns the same row, never a second authorization.
    await expect(store.putAuthorization(authorization)).resolves.toMatchObject({
      authorizationId: authorization.authorizationId,
    });
    expect(await count("release_shadow_authorizations")).toBe("1");
  });
});

describeDb("terminal prerequisite authority atomicity", () => {
  it("terminal prerequisite authority atomicity", async () => {
    h = await bootHarness({ publishReleaseCheck: false });
    const store = new ReleaseAuthorityStore(h.pool);

    // A v3 ship report A bound to evidence snapshot dA (a first green attempt).
    const snapA = buildPrerequisiteSnapshot(cleanAuthority(), passedAggregate(wfEvidence()));
    const reportA = shipReport(snapA);
    await persistShip(reportA, snapA.evidenceDigest);

    // A successor v3 ship report B (a green rerun → a new attempt → a new digest) for the
    // SAME envelope. B becomes latest through the envelope authority fence.
    const snapB = buildPrerequisiteSnapshot(
      cleanAuthority(),
      passedAggregate(wfEvidence({ runAttempt: 2 })),
    );
    const reportB = shipReport(snapB);
    expect(snapB.evidenceDigest).not.toBe(snapA.evidenceDigest);
    expect(reportB.reportId).not.toBe(reportA.reportId);
    await persistShip(reportB, snapB.evidenceDigest);
    expect((await store.latestReportForEnvelope(reportA.subject))?.reportId).toBe(reportB.reportId);

    // FORCED RACE: many concurrent attempts to authorize the SUPERSEDED report A. The
    // terminal transaction takes the envelope advisory lock and re-checks the latest
    // report under the same transaction that would record the authorization, so every
    // attempt refuses and NO partial authority record is left behind.
    const authA = shipAuthorization(reportA, snapA.evidenceDigest);
    const raced = await Promise.allSettled(
      Array.from({ length: 5 }, () => store.putAuthorization(authA)),
    );
    expect(raced.every((r) => r.status === "rejected")).toBe(true);
    for (const r of raced) {
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(ReleaseAuthorityIntegrityError);
      }
    }
    expect(await count("release_shadow_authorizations")).toBe("0");

    // Even the CURRENT report B refuses an authorization carrying report A's STALE
    // evidence digest — the digest binding fails under the same terminal transaction.
    await expect(
      store.putAuthorization(shipAuthorization(reportB, snapA.evidenceDigest)),
    ).rejects.toBeInstanceOf(ReleaseAuthorityIntegrityError);
    expect(await count("release_shadow_authorizations")).toBe("0");

    // The exact current report B with its matching evidence digest authorizes.
    await expect(
      store.putAuthorization(shipAuthorization(reportB, snapB.evidenceDigest)),
    ).resolves.toMatchObject({ outcome: "ship", shadowOnly: true });
    expect(await count("release_shadow_authorizations")).toBe("1");
  });
});
