import { afterEach, expect, it } from "vitest";
import { describeDb } from "../support/db.js";
import { bootHarness, HARNESS_REQUIRED_CI_CONTEXTS, type Harness } from "../harness/boot.js";
import { REPO } from "../fixtures/scenarios.js";
import { ReleaseAuthorityService, ReleaseAuthorityError } from "../../src/app/release-authority.js";
import { ReleaseAuthorityStore } from "../../src/persistence/release-authority.js";
import type {
  WorkflowApprovalReader,
  WorkflowEnvironmentApproval,
} from "../../src/providers/scm/port.js";
import type { WorkflowIdentity } from "../../src/domain/release/authority.js";

const PREV = "a1".repeat(20);
const SHIP_CAND = "b2".repeat(20);
const SIGNOFF_CAND = "c3".repeat(20);
const STOP_CAND = "d4".repeat(20);
const ARTIFACT = `sha256:${"e5".repeat(32)}`;
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

function service(approvals = new FakeApprovals()) {
  return {
    approvals,
    authority: new ReleaseAuthorityService({
      scruffy: h.scruffy,
      store: new ReleaseAuthorityStore(h.pool),
      approvals,
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

async function seedShip() {
  h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: SHIP_CAND }, [
    { path: "src/clean.ts", patch: "@@ -0,0 +1 @@\n+export const clean = true;" },
  ]);
  h.scm.seedCandidateCi(
    { repository: REPO, commitSha: SHIP_CAND },
    {
      sha: SHIP_CAND,
      records: HARNESS_REQUIRED_CI_CONTEXTS.map((context) => ({
        context,
        state: "success" as const,
        sha: SHIP_CAND,
        source: "check-run" as const,
      })),
    },
  );
}

async function seedSignoff() {
  h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: SIGNOFF_CAND }, [
    {
      path: "src/http.ts",
      patch: "@@ -0,0 +1 @@\n+const agent = { rejectUnauthorized: false };",
    },
  ]);
}

afterEach(async () => {
  await h?.pool.end();
});

describeDb("hosted release report protocol", () => {
  it("hosted release report protocol", async () => {
    h = await bootHarness({ publishReleaseCheck: false });
    await seedShip();
    const { authority } = service();
    const report = await authority.requestReport(identity, envelope(SHIP_CAND));
    expect(report.subject).toEqual(envelope(SHIP_CAND));
    expect(report.decision.outcome).toBe("ship");
    await expect(authority.getReport(identity, report.reportId)).resolves.toEqual(report);
    await expect(authority.requestReport(identity, envelope(SHIP_CAND))).resolves.toMatchObject({
      reportId: report.reportId,
    });
    expect(h.scm.recordedCheckRuns()).toHaveLength(0);
    await expect(
      authority.requestReport({ ...identity, repository: "evil/repo" }, envelope(SHIP_CAND)),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      authority.requestReport(identity, {
        ...envelope(SHIP_CAND),
        targetEnvironment: "unapproved-production",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describeDb("protected environment attestation", () => {
  it("protected environment attestation", async () => {
    h = await bootHarness({ publishReleaseCheck: false });
    await seedSignoff();
    const { authority, approvals } = service();
    const report = await authority.requestReport(identity, envelope(SIGNOFF_CAND));
    expect(report.decision.outcome).toBe("sign-off-required");
    const input = {
      rationale: "Accept the controlled TLS exception for this shadow run.",
      responsibilityAccepted: true as const,
      responsibilityAccepter: identity.actor,
    };

    await expect(authority.attest(identity, report.reportId, input)).rejects.toBeInstanceOf(
      ReleaseAuthorityError,
    );
    approvals.approvals = [
      {
        environment: APPROVAL_ENVIRONMENT,
        state: "approved",
        reviewer: identity.actor,
        reviewedAt: "2026-07-15T00:01:00.000Z",
      },
    ];
    const attestation = await authority.attest(identity, report.reportId, input);
    expect(attestation).toMatchObject({
      reportId: report.reportId,
      envelope: envelope(SIGNOFF_CAND),
      reviewer: identity.actor,
      responsibilityAccepter: identity.actor,
    });
    await expect(authority.attest(identity, report.reportId, input)).resolves.toMatchObject({
      attestationId: attestation.attestationId,
    });

    approvals.approvals = [
      {
        environment: APPROVAL_ENVIRONMENT,
        state: "approved",
        reviewer: { login: "someone-else", id: "999" },
        reviewedAt: "2026-07-15T00:01:00.000Z",
      },
    ];
    await expect(authority.attest(identity, report.reportId, input)).rejects.toMatchObject({
      status: 403,
    });
    approvals.runAttempt = 2;
    await expect(authority.attest(identity, report.reportId, input)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describeDb("terminal shadow authorization", () => {
  it("terminal shadow authorization", async () => {
    h = await bootHarness({ publishReleaseCheck: false });
    await seedShip();
    await seedSignoff();
    const { authority, approvals } = service();

    const ship = await authority.requestReport(identity, envelope(SHIP_CAND));
    const shipAuthorization = await authority.authorize(identity, ship.reportId, {
      envelope: ship.subject,
      attestationId: null,
    });
    expect(shipAuthorization).toMatchObject({
      outcome: "ship",
      shadowOnly: true,
      attestationId: null,
    });
    await expect(
      authority.authorize(identity, ship.reportId, {
        envelope: { ...ship.subject, targetEnvironment: "other" },
        attestationId: null,
      }),
    ).rejects.toMatchObject({ status: 409 });

    const signoff = await authority.requestReport(identity, envelope(SIGNOFF_CAND));
    await expect(
      authority.authorize(identity, signoff.reportId, { envelope: signoff.subject }),
    ).rejects.toMatchObject({ status: 409 });
    approvals.approvals = [
      {
        environment: APPROVAL_ENVIRONMENT,
        state: "approved",
        reviewer: identity.actor,
        reviewedAt: "2026-07-15T00:01:00.000Z",
      },
    ];
    const attestation = await authority.attest(identity, signoff.reportId, {
      rationale: "Controlled exception",
      responsibilityAccepted: true,
      responsibilityAccepter: identity.actor,
    });
    await expect(
      authority.authorize(identity, signoff.reportId, {
        envelope: signoff.subject,
        attestationId: attestation.attestationId,
      }),
    ).resolves.toMatchObject({ outcome: "sign-off-required", shadowOnly: true });
    await expect(
      authority.authorize({ ...identity, runId: "999" }, signoff.reportId, {
        envelope: signoff.subject,
        attestationId: attestation.attestationId,
      }),
    ).rejects.toMatchObject({ status: 409 });

    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: STOP_CAND }, [
      {
        path: "src/config.ts",
        patch: `@@ -0,0 +1 @@\n+export const key = '${["AKIA", "IJKLMNOP12345678"].join("")}';`,
      },
    ]);
    const stop = await authority.requestReport(identity, envelope(STOP_CAND));
    expect(stop.decision.outcome).toBe("stop");
    await expect(
      authority.authorize(identity, stop.reportId, { envelope: stop.subject }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
