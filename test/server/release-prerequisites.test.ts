import { afterEach, expect, it } from "vitest";
import { describeDb } from "../support/db.js";
import { bootHarness, HARNESS_REQUIRED_CI_CONTEXTS, type Harness } from "../harness/boot.js";
import { REPO } from "../fixtures/scenarios.js";
import { ReleaseAuthorityService } from "../../src/app/release-authority.js";
import { ReleaseAuthorityStore } from "../../src/persistence/release-authority.js";
import type {
  WorkflowApprovalReader,
  WorkflowEnvironmentApproval,
} from "../../src/providers/scm/port.js";
import type { WorkflowIdentity } from "../../src/domain/release/authority.js";
import { RELEASE_CONFIG_PATH } from "../../src/domain/release/repository-config.js";
import type {
  RequiredWorkflowEvidence,
  WorkflowRunResolution,
} from "../../src/domain/release/required-workflow-evidence.js";
import { resolveReleasePrerequisites } from "../../src/gates/release/prerequisites.js";

const POLICY_VERSION = "policy-v1";

/**
 * Wiring of the repository-owned workflow-prerequisite lane into the authenticated
 * hosted release protocol AND the terminal authorization boundary.
 *
 * The service here is prerequisite-aware — it is constructed WITH the exact-SHA source
 * reader and the read-only Actions run reader (both `FakeScm`), so it reads candidate
 * configuration, authority-change, and exact current workflow evidence before returning
 * an approvable report, and re-reads that evidence immediately before authorization.
 *
 * The obvious broken implementation checks workflows only at report creation; every
 * mutation between report/approval and authorization below must fail it.
 */

const WF = ".github/workflows/ci.yml";
const CONFIG = `version: 1\nrequiredWorkflows:\n  - ${WF}\n`;
// Structurally invalid (unknown key) — authorization-ineligible, NEVER an approvable
// workflow failure.
const BAD_CONFIG = `version: 1\nrequiredWorkflows:\n  - ${WF}\nbogus: true\n`;

const PREV = "a1".repeat(20);
const ARTIFACT = `sha256:${"aa".repeat(32)}`;
const ENVIRONMENT = "shadow-production";
const APPROVAL_ENVIRONMENT = "scruffy-production-signoff";
let h: Harness;

class FakeApprovals implements WorkflowApprovalReader {
  approvals: WorkflowEnvironmentApproval[] = [];
  runAttempt = 1;
  async getWorkflowRunApprovals() {
    return { runAttempt: this.runAttempt, approvals: this.approvals };
  }
}

const identity: WorkflowIdentity = {
  issuer: "https://token.actions.githubusercontent.com",
  audience: "scruffy-release",
  repository: REPO,
  repositoryId: "123",
  workflowRef: "acme/control/.github/workflows/release.yml@deadbeef",
  runId: "456",
  runAttempt: 1,
  actor: { login: "release-owner", id: "789" },
  environment: APPROVAL_ENVIRONMENT,
};
const requestIdentity: WorkflowIdentity = { ...identity, environment: null };

function service(approvals = new FakeApprovals()) {
  return {
    approvals,
    authority: new ReleaseAuthorityService({
      scruffy: h.scruffy,
      store: new ReleaseAuthorityStore(h.pool),
      approvals,
      // Prerequisite-aware: the FakeScm satisfies BOTH the source reader and the
      // read-only Actions run reader ports.
      scm: h.scm,
      workflowRuns: h.scm,
      clock: h.clock,
      targetEnvironment: ENVIRONMENT,
      approvalEnvironment: APPROVAL_ENVIRONMENT,
    }),
  };
}

function envelope(candidateSha: string) {
  return {
    repository: REPO,
    previousReleaseSha: PREV,
    candidateSha,
    artifactDigest: ARTIFACT,
    targetEnvironment: ENVIRONMENT,
  };
}

function wfEvidence(candidate: string, over: Partial<RequiredWorkflowEvidence> = {}): RequiredWorkflowEvidence {
  return {
    workflowId: 7,
    workflowPath: WF,
    runId: 100,
    runAttempt: 1,
    event: "push",
    branch: "main",
    candidateSha: candidate,
    status: "completed",
    conclusion: "success",
    url: `https://github.com/${REPO}/actions/runs/100`,
    ...over,
  };
}

/** Seed the current required-workflow resolution for an exact candidate (branch "main"). */
function seedWorkflow(candidate: string, resolution: WorkflowRunResolution): void {
  h.scm.seedRequiredWorkflowRun(
    { repository: REPO, workflowPath: WF, candidateSha: candidate, defaultBranch: "main" },
    resolution,
  );
}

function passed(candidate: string, over: Partial<RequiredWorkflowEvidence> = {}): WorkflowRunResolution {
  return { kind: "resolved", evidence: wfEvidence(candidate, over) };
}

/** The baseline previous configuration, so a candidate is never a first adoption. */
function seedPreviousBaseline(): void {
  h.scm.seedFileContent({ repository: REPO, commitSha: PREV }, RELEASE_CONFIG_PATH, CONFIG);
}

/** Seed candidate config + a clean source range + green candidate CI for a candidate. */
function seedCleanCandidate(candidate: string, config = CONFIG): void {
  h.scm.seedFileContent({ repository: REPO, commitSha: candidate }, RELEASE_CONFIG_PATH, config);
  h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: candidate }, [
    { path: "src/clean.ts", patch: "@@ -0,0 +1 @@\n+export const clean = true;" },
  ]);
  h.scm.seedCandidateCi(
    { repository: REPO, commitSha: candidate },
    {
      sha: candidate,
      records: HARNESS_REQUIRED_CI_CONTEXTS.map((context) => ({
        context,
        state: "success" as const,
        sha: candidate,
        source: "check-run" as const,
      })),
    },
  );
}

/** A clean, green candidate whose only prerequisite signal is a single passed workflow. */
function seedGreen(candidate: string): void {
  seedCleanCandidate(candidate);
  seedWorkflow(candidate, passed(candidate));
}

async function authorizationCount(): Promise<string> {
  const r = await h.pool.query<{ count: string }>("select count(*) from release_shadow_authorizations");
  return r.rows[0]!.count;
}

afterEach(async () => {
  await h?.pool.end();
});

describeDb("hosted prerequisite readiness", () => {
  it("hosted prerequisite readiness", async () => {
    h = await bootHarness({ publishReleaseCheck: false });
    seedPreviousBaseline();
    const { authority } = service();
    const store = new ReleaseAuthorityStore(h.pool);

    // 1. GREEN — all workflows passed, authority unchanged: reaches analysis and ships.
    const GREEN = "b2".repeat(20);
    seedGreen(GREEN);
    const green = await authority.requestReport(requestIdentity, envelope(GREEN));
    expect(green.decision.outcome).toBe("ship");
    expect(green.reportVersion).toBe("3");
    expect(green.prerequisite?.aggregate.outcome).toBe("satisfied");

    // 2. TERMINAL FAILURE — a completed non-success workflow forces sign-off.
    const FAIL = "c3".repeat(20);
    seedCleanCandidate(FAIL);
    seedWorkflow(FAIL, passed(FAIL, { conclusion: "failure" }));
    const failed = await authority.requestReport(requestIdentity, envelope(FAIL));
    expect(failed.decision.outcome).toBe("sign-off-required");
    expect(failed.decision.reasons).toContain("required_workflow_failed");

    // 3. AUTHORITY CHANGE — a changed workflow file forces sign-off even though green.
    const AUTH = "d4".repeat(20);
    seedGreen(AUTH);
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: AUTH }, [
      { path: WF, patch: "@@ -0,0 +1 @@\n+name: ci" },
    ]);
    const changed = await authority.requestReport(requestIdentity, envelope(AUTH));
    expect(changed.decision.outcome).toBe("sign-off-required");
    expect(changed.decision.reasons).toContain("release_authority_changed");

    // 4. PENDING — not a result: retryable not-ready, never enters approval.
    const PEND = "e5".repeat(20);
    seedCleanCandidate(PEND);
    seedWorkflow(PEND, passed(PEND, { status: "in_progress", conclusion: null }));
    await expect(authority.requestReport(requestIdentity, envelope(PEND))).rejects.toMatchObject({
      status: 409,
      retryable: true,
      reasonCodes: ["required_workflow_pending"],
    });

    // 5. INVALID CONFIG — authorization-ineligible, never an approvable workflow failure.
    const INVAL = "f6".repeat(20);
    seedCleanCandidate(INVAL, BAD_CONFIG);
    await expect(authority.requestReport(requestIdentity, envelope(INVAL))).rejects.toMatchObject({
      status: 409,
      retryable: false,
      reasonCodes: ["release_config_invalid"],
    });

    // 6. ABSENT — no matching run: fail closed, cannot be approved as if it failed.
    const ABSENT = "07".repeat(20);
    seedCleanCandidate(ABSENT); // config valid, but no workflow run seeded → absent
    await expect(authority.requestReport(requestIdentity, envelope(ABSENT))).rejects.toMatchObject({
      status: 409,
      retryable: false,
      reasonCodes: ["required_workflow_absent"],
    });

    // 7. UNVERIFIABLE — a provider fault must not be mistaken for a failure.
    const UNVER = "18".repeat(20);
    seedCleanCandidate(UNVER);
    seedWorkflow(UNVER, { kind: "unverifiable", workflowPath: WF, detail: "provider fault" });
    await expect(authority.requestReport(requestIdentity, envelope(UNVER))).rejects.toMatchObject({
      status: 409,
      retryable: false,
      reasonCodes: ["required_workflow_unverifiable"],
    });

    // A run whose identity carries the prerequisite evidence digest but was decided
    // WITHOUT resolving prerequisites (the background reconciler drives with no
    // prerequisite context → a v2 report) must NEVER be handed out as approvable, even
    // though a fresh request deduplicates onto it. This is the fail-closed guard that
    // stops the whole workflow lane from being bypassed by an interleaved reconcile.
    const V2 = "4b".repeat(20);
    seedGreen(V2);
    const resolved = await resolveReleasePrerequisites(
      { repository: REPO, candidateSha: V2, previousReleaseSha: PREV },
      { scm: h.scm, workflowRuns: h.scm },
    );
    const bypassRun = await h.scruffy.runs.ensureReleaseRun(
      { repository: REPO, commitSha: V2 },
      PREV,
      ARTIFACT,
      ENVIRONMENT,
      POLICY_VERSION,
      resolved.snapshot.evidenceDigest,
    );
    const decided = await h.scruffy.release.reconcile(bypassRun);
    expect(decided.state).toBe("decided");
    const v2Report = (await store.getReportForRun(bypassRun.id))!;
    expect(v2Report.reportVersion).toBe("2");
    expect(v2Report.decision.outcome).toBe("ship");
    // requestReport deduplicates onto that decided v2 run and REFUSES it (fail closed).
    await expect(authority.requestReport(requestIdentity, envelope(V2))).rejects.toMatchObject({
      status: 409,
    });
    // The v2 report cannot be authorized directly either — the freshness/lane bypass is
    // closed at the terminal boundary too.
    await expect(
      authority.authorize(identity, v2Report.reportId, {
        envelope: v2Report.subject,
        attestationId: null,
      }),
    ).rejects.toMatchObject({ status: 409 });

    // None of the not-approvable candidates ever recorded a report-request observation —
    // approval ordering never began for evidence that is not a result.
    const requests = await h.pool.query<{ count: string }>(
      "select count(*) from release_report_requests",
    );
    // Exactly the two approvable reports (ship + sign-off failure + authority change) —
    // pending/invalid/absent/unverifiable recorded none.
    expect(Number(requests.rows[0]!.count)).toBe(3);
  });
});

describeDb("authorization workflow freshness", () => {
  it("authorization workflow freshness", async () => {
    h = await bootHarness({ publishReleaseCheck: false });
    seedPreviousBaseline();
    const { authority, approvals } = service();

    // A green ship report authorizes when the re-read evidence is exactly unchanged.
    const OK = "b2".repeat(20);
    seedGreen(OK);
    const ok = await authority.requestReport(requestIdentity, envelope(OK));
    expect(ok.decision.outcome).toBe("ship");
    await expect(
      authority.authorize(identity, ok.reportId, { envelope: ok.subject, attestationId: null }),
    ).resolves.toMatchObject({ outcome: "ship", shadowOnly: true });
    expect(await authorizationCount()).toBe("1");

    // Each freshness mutation below refuses the SHIP path: the report was minted against
    // one evidence snapshot; changed evidence cannot authorize it.
    const refuseShip = async (candidate: string, mutate: () => void) => {
      seedGreen(candidate);
      const report = await authority.requestReport(requestIdentity, envelope(candidate));
      expect(report.decision.outcome).toBe("ship");
      mutate();
      await expect(
        authority.authorize(identity, report.reportId, {
          envelope: report.subject,
          attestationId: null,
        }),
      ).rejects.toMatchObject({ status: 409 });
    };

    // newer attempt (a rerun supersedes the earlier attempt).
    await refuseShip("c3".repeat(20), () =>
      seedWorkflow("c3".repeat(20), passed("c3".repeat(20), { runAttempt: 2 })),
    );
    // a pending rerun.
    await refuseShip("d4".repeat(20), () =>
      seedWorkflow("d4".repeat(20), passed("d4".repeat(20), { status: "in_progress", conclusion: null })),
    );
    // a changed conclusion (green flips to a terminal failure).
    await refuseShip("e5".repeat(20), () =>
      seedWorkflow("e5".repeat(20), passed("e5".repeat(20), { conclusion: "failure" })),
    );
    // an authority mutation (a workflow file change appears in the range).
    await refuseShip("f6".repeat(20), () =>
      h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: "f6".repeat(20) }, [
        { path: WF, patch: "@@ -0,0 +1 @@\n+name: ci" },
      ]),
    );
    // an identity mismatch (a different run id for the exact workflow/candidate).
    await refuseShip("07".repeat(20), () =>
      seedWorkflow("07".repeat(20), passed("07".repeat(20), { runId: 999 })),
    );
    // a provider fault re-reading the default branch.
    await refuseShip("18".repeat(20), () => h.scm.failDefaultBranch(REPO));

    // Only the single unmutated ship authorization ever committed.
    expect(await authorizationCount()).toBe("1");

    // The SIGN-OFF path revalidates the same way. A terminal-failure report is attested,
    // then a rerun to success invalidates the old approval path.
    const SIGN = "29".repeat(20);
    seedCleanCandidate(SIGN);
    seedWorkflow(SIGN, passed(SIGN, { conclusion: "failure" }));
    const signoff = await authority.requestReport(requestIdentity, envelope(SIGN));
    expect(signoff.decision.outcome).toBe("sign-off-required");
    approvals.approvals = [
      { environment: APPROVAL_ENVIRONMENT, state: "approved", reviewer: identity.actor },
    ];
    const attestation = await authority.attest(identity, signoff.reportId, {
      rationale: "Accept the controlled failed-workflow exception.",
      responsibilityAccepted: true,
      responsibilityAccepter: identity.actor,
    });

    // Exact unchanged evidence authorizes the sign-off.
    await expect(
      authority.authorize(identity, signoff.reportId, {
        envelope: signoff.subject,
        attestationId: attestation.attestationId,
      }),
    ).resolves.toMatchObject({ outcome: "sign-off-required", shadowOnly: true });

    // A second sign-off whose failed workflow is rerun to success cannot authorize.
    const SIGN2 = "3a".repeat(20);
    seedCleanCandidate(SIGN2);
    seedWorkflow(SIGN2, passed(SIGN2, { conclusion: "failure" }));
    const signoff2 = await authority.requestReport(requestIdentity, envelope(SIGN2));
    const attestation2 = await authority.attest(identity, signoff2.reportId, {
      rationale: "Accept the controlled failed-workflow exception.",
      responsibilityAccepted: true,
      responsibilityAccepter: identity.actor,
    });
    // Rerun to success — the evidence digest changes.
    seedWorkflow(SIGN2, passed(SIGN2, { runAttempt: 2, conclusion: "success" }));
    await expect(
      authority.authorize(identity, signoff2.reportId, {
        envelope: signoff2.subject,
        attestationId: attestation2.attestationId,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describeDb("prerequisite-bound attestation", () => {
  it("prerequisite-bound attestation", async () => {
    h = await bootHarness({ publishReleaseCheck: false });
    seedPreviousBaseline();
    const { authority, approvals } = service();
    const store = new ReleaseAuthorityStore(h.pool);

    // A sign-off report caused by a terminal workflow failure.
    const CAND = "b2".repeat(20);
    seedCleanCandidate(CAND);
    seedWorkflow(CAND, passed(CAND, { runAttempt: 1, runId: 100, conclusion: "failure" }));
    const signoff = await authority.requestReport(requestIdentity, envelope(CAND));
    expect(signoff.decision.outcome).toBe("sign-off-required");
    expect(signoff.prerequisite?.evidenceDigest).toMatch(/^pe_[0-9a-f]{64}$/);

    approvals.approvals = [
      { environment: APPROVAL_ENVIRONMENT, state: "approved", reviewer: identity.actor },
    ];
    const attestation = await authority.attest(identity, signoff.reportId, {
      rationale: "Accept the controlled failed-workflow exception.",
      responsibilityAccepted: true,
      responsibilityAccepter: identity.actor,
    });

    // The attestation binds the EXACT prerequisite evidence snapshot of the report.
    expect(attestation.prereqEvidenceDigest).toBe(signoff.prerequisite!.evidenceDigest);

    // A rerun (new attempt) produces a SUCCESSOR sign-off report for the same envelope,
    // which becomes latest.
    seedWorkflow(CAND, passed(CAND, { runAttempt: 2, runId: 100, conclusion: "failure" }));
    const successor = await authority.requestReport(requestIdentity, envelope(CAND));
    expect(successor.reportId).not.toBe(signoff.reportId);
    expect(successor.decision.outcome).toBe("sign-off-required");
    expect(successor.prerequisite!.evidenceDigest).not.toBe(signoff.prerequisite!.evidenceDigest);
    expect((await store.latestReportForEnvelope(signoff.subject))?.reportId).toBe(successor.reportId);

    // The attestation cannot authorize the superseded original report.
    await expect(
      authority.authorize(identity, signoff.reportId, {
        envelope: signoff.subject,
        attestationId: attestation.attestationId,
      }),
    ).rejects.toMatchObject({ status: 409 });

    // Nor can it be carried onto the successor report — it binds a different report and
    // a different evidence snapshot.
    await expect(
      authority.authorize(identity, successor.reportId, {
        envelope: successor.subject,
        attestationId: attestation.attestationId,
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(await authorizationCount()).toBe("0");
  });
});
