import { afterEach, expect, it } from "vitest";
import { describeDb } from "../support/db.js";
import { bootHarness, type Harness } from "../harness/boot.js";
import { REPO } from "../fixtures/scenarios.js";
import { ReleaseAuthorityStore } from "../../src/persistence/release-authority.js";
import {
  ReleaseShadowAuthorization,
  computeAuthorizationId,
  type WorkflowIdentity,
} from "../../src/domain/release/authority.js";

const PREV = "a1".repeat(20);
const CAND = "b2".repeat(20);
const ARTIFACT = `sha256:${"d4".repeat(32)}`;
const identity: WorkflowIdentity = {
  issuer: "https://token.actions.githubusercontent.com",
  audience: "scruffy-release",
  repository: REPO,
  repositoryId: "123",
  workflowRef: "acme/control/.github/workflows/release.yml@deadbeef",
  runId: "456",
  runAttempt: 1,
  actor: { login: "owner", id: "789" },
  environment: "scruffy-production-signoff",
};
let h: Harness;

afterEach(async () => h?.pool.end());

describeDb("authority idempotency and atomicity", () => {
  it("authority idempotency and atomicity", async () => {
    h = await bootHarness({ publishReleaseCheck: false });
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: CAND }, [
      { path: "src/http.ts", patch: "@@ -0,0 +1 @@\n+const x = { rejectUnauthorized: false };" },
    ]);
    const run = await h.scruffy.runRelease({
      repository: REPO,
      candidate: CAND,
      prevRelease: PREV,
      artifactDigest: ARTIFACT,
      targetEnvironment: "shadow-production",
    });
    const store = new ReleaseAuthorityStore(h.pool);
    const report = (await store.getReportForRun(run.id))!;
    expect(report.decision.outcome).toBe("sign-off-required");

    const content = {
      authorizationVersion: "1" as const,
      reportId: report.reportId,
      envelope: report.subject,
      outcome: "sign-off-required" as const,
      attestationId: `ra_${"0".repeat(64)}`,
      workflow: identity,
      shadowOnly: true as const,
    };
    const authorization = ReleaseShadowAuthorization.parse({
      ...content,
      authorizationId: computeAuthorizationId(content),
      authorizedAt: "2026-07-15T00:00:00.000Z",
    });
    await expect(store.putAuthorization(authorization)).rejects.toThrow(/attestation not found/);
    const count = await h.pool.query("select count(*) from release_shadow_authorizations");
    expect(count.rows[0]!.count).toBe("0");
  });
});
