import { afterEach, expect, it } from "vitest";
import { describeDb } from "../support/db.js";
import { bootHarness, type Harness } from "../harness/boot.js";
import { REPO } from "../fixtures/scenarios.js";
import { ReleaseAuthorityStore } from "../../src/persistence/release-authority.js";

const PREV = "a1".repeat(20);
const CAND = "b2".repeat(20);
const ARTIFACT_A = `sha256:${"d4".repeat(32)}`;
const ARTIFACT_B = `sha256:${"e5".repeat(32)}`;
let h: Harness;

afterEach(async () => {
  await h?.pool.end();
});

describeDb("release envelope persistence", () => {
  it("release envelope persistence", async () => {
    h = await bootHarness();
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: CAND }, [
      { path: "src/clean.ts", patch: "@@ -0,0 +1 @@\n+export const clean = true;" },
    ]);

    const first = await h.scruffy.runRelease({
      repository: REPO,
      candidate: CAND,
      prevRelease: PREV,
      artifactDigest: ARTIFACT_A,
      targetEnvironment: "shadow-a",
    });
    const second = await h.scruffy.runRelease({
      repository: REPO,
      candidate: CAND,
      prevRelease: PREV,
      artifactDigest: ARTIFACT_B,
      targetEnvironment: "shadow-b",
    });
    const replay = await h.scruffy.runRelease({
      repository: REPO,
      candidate: CAND,
      prevRelease: PREV,
      artifactDigest: ARTIFACT_A,
      targetEnvironment: "shadow-a",
    });

    expect(second.id).not.toBe(first.id);
    expect(replay.id).toBe(first.id);
    const store = new ReleaseAuthorityStore(h.pool);
    const reportA = await store.getReportForRun(first.id);
    const reportB = await store.getReportForRun(second.id);
    expect(reportA?.reportId).not.toBe(reportB?.reportId);
    expect(reportA?.subject).toMatchObject({
      artifactDigest: ARTIFACT_A,
      targetEnvironment: "shadow-a",
    });
    expect(reportB?.subject).toMatchObject({
      artifactDigest: ARTIFACT_B,
      targetEnvironment: "shadow-b",
    });
    await expect(store.latestReportForEnvelope(reportA!.subject)).resolves.toMatchObject({
      reportId: reportA!.reportId,
    });
    await expect(store.latestReportForEnvelope(reportB!.subject)).resolves.toMatchObject({
      reportId: reportB!.reportId,
    });
    const effects = await h.pool.query<{ external_id: string }>(
      "select external_id from outbox where run_id = any($1::text[]) order by external_id",
      [[first.id, second.id]],
    );
    expect(effects.rows.map((row) => row.external_id)).toEqual([
      `release:${REPO}:${CAND}:${ARTIFACT_A}:shadow-a`,
      `release:${REPO}:${CAND}:${ARTIFACT_B}:shadow-b`,
    ]);
  });
});

describeDb("historical release report compatibility", () => {
  it("historical release report compatibility", async () => {
    h = await bootHarness();
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: CAND }, [
      { path: "src/clean.ts", patch: "@@ -0,0 +1 @@\n+export const clean = true;" },
    ]);
    const currentRun = await h.scruffy.runRelease({
      repository: REPO,
      candidate: CAND,
      prevRelease: PREV,
      artifactDigest: ARTIFACT_A,
      targetEnvironment: "shadow-a",
    });
    const current = (await new ReleaseAuthorityStore(h.pool).getReportForRun(currentRun.id))!;
    const {
      artifactDigest: _artifact,
      targetEnvironment: _environment,
      ...legacySubject
    } = current.subject;
    const legacy = {
      ...current,
      reportVersion: "1",
      reportId: "rr_legacy",
      subject: legacySubject,
    };
    const now = new Date("2026-07-31T00:00:00.000Z");
    await h.pool.query(
      `insert into evaluation_runs
         (id, kind, repository, commit_sha, merge_group_sha, base_sha, branch, policy_version,
          state, attempt, created_at, updated_at)
       values ('run_legacy', 'release', $1, $2, null, $3, null, 'policy-v0',
               'decided', 1, $4, $4)`,
      [REPO, "c3".repeat(20), PREV, now],
    );
    await h.pool.query(
      `insert into release_reports
         (run_id, report_id, report_version, repository, previous_release_sha, candidate_sha,
          policy_version, report, generated_at, created_at)
       values ('run_legacy', 'rr_legacy', '1', $1, $2, $3, 'policy-v0', $4, $5, $5)`,
      [REPO, PREV, "c3".repeat(20), JSON.stringify(legacy), now],
    );

    const store = new ReleaseAuthorityStore(h.pool);
    const stored = await store.getReport("rr_legacy");
    expect(stored?.reportVersion).toBe("1");
    await expect(store.getCurrentReport("rr_legacy")).resolves.toBeNull();
  });
});
