import { describe, expect, it } from "vitest";
import { FakeScm } from "../../src/providers/scm/fake.js";
import { RELEASE_CONFIG_PATH } from "../../src/domain/release/repository-config.js";
import {
  evaluateReleaseAuthority,
  type ReleaseAuthorityRange,
} from "../../src/gates/release/release-authority.js";
import type { ChangedFile } from "../../src/providers/scm/port.js";

/**
 * The release-authority lane compares the immutable `(previousReleaseSha,
 * candidateSha]` range. Unchanged configuration AND unchanged authority paths are
 * clean; a first adoption or ANY change under `.github/scruffy-release.yml`,
 * `.github/workflows/**`, or `.github/actions/**` requires a protected sign-off.
 * Unrelated source changes must NOT manufacture an authority change.
 *
 * The obvious broken detector only inspects the configured top-level workflow and
 * misses a changed LOCAL reusable workflow / composite action; the broad-path cases
 * below fail that detector. A separate group proves that missing / malformed / empty
 * / self-referential candidate configuration is authorization-INELIGIBLE — never an
 * approvable exception.
 */

const REPO = "acme/web";
const PREV = "a1".repeat(20);
const CAND = "b2".repeat(20);

function config(...workflows: string[]): string {
  return (
    ["version: 1", "requiredWorkflows:", ...workflows.map((w) => `  - ${w}`)].join("\n") + "\n"
  );
}

const CI = ".github/workflows/ci.yml";
const INTEGRATION = ".github/workflows/integration.yml";
const LOCAL_ACTION = ".github/actions/build/action.yml";

function seedRange(scm: FakeScm, baseSha: string | null, changed: string[]): void {
  const files: ChangedFile[] = changed.map((path) => ({ path, patch: "@@ -1 +1 @@\n-x\n+y" }));
  scm.seedChangedFilesInRange({ repository: REPO, baseSha, headSha: CAND }, files);
}

function range(previousReleaseSha: string | null): ReleaseAuthorityRange {
  return { repository: REPO, candidateSha: CAND, previousReleaseSha };
}

describe("release authority change detection", () => {
  it("is clean when config and authority are unchanged since an established baseline", async () => {
    const scm = new FakeScm();
    scm.seedFileContent({ repository: REPO, commitSha: PREV }, RELEASE_CONFIG_PATH, config(CI));
    scm.seedFileContent({ repository: REPO, commitSha: CAND }, RELEASE_CONFIG_PATH, config(CI));
    // Only unrelated source changed in the range — never an authority change.
    seedRange(scm, PREV, ["src/app.ts", "README.md", "test/app.test.ts"]);

    const assessment = await evaluateReleaseAuthority(range(PREV), scm);

    expect(assessment.outcome).toBe("clean");
    expect(assessment.reasonCode).toBe("authority_unchanged");
    expect(assessment.firstAdoption).toBe(false);
    expect(assessment.configChanged).toBe(false);
    expect(assessment.changedAuthorityPaths).toEqual([]);
  });

  it("requires sign-off on first release to establish a baseline", async () => {
    const scm = new FakeScm();
    scm.seedFileContent({ repository: REPO, commitSha: CAND }, RELEASE_CONFIG_PATH, config(CI));
    seedRange(scm, null, [CI, "src/app.ts"]);

    const assessment = await evaluateReleaseAuthority(range(null), scm);

    expect(assessment.outcome).toBe("sign-off-required");
    expect(assessment.reasonCode).toBe("release_authority_baseline_required");
    expect(assessment.firstAdoption).toBe(true);
    expect(assessment.candidate?.config.requiredWorkflows).toEqual([CI]);
    expect(assessment.previous).toBeNull();
  });

  it("requires sign-off when there is no readable previous configuration", async () => {
    const scm = new FakeScm();
    // Previous release exists but never carried a readable configuration.
    scm.seedFileContent({ repository: REPO, commitSha: CAND }, RELEASE_CONFIG_PATH, config(CI));
    seedRange(scm, PREV, ["src/app.ts"]);

    const assessment = await evaluateReleaseAuthority(range(PREV), scm);

    expect(assessment.outcome).toBe("sign-off-required");
    expect(assessment.reasonCode).toBe("release_authority_baseline_required");
    expect(assessment.firstAdoption).toBe(true);
  });

  it("requires sign-off when the configuration itself changes", async () => {
    const scm = new FakeScm();
    scm.seedFileContent({ repository: REPO, commitSha: PREV }, RELEASE_CONFIG_PATH, config(CI));
    scm.seedFileContent(
      { repository: REPO, commitSha: CAND },
      RELEASE_CONFIG_PATH,
      config(CI, INTEGRATION),
    );
    seedRange(scm, PREV, [RELEASE_CONFIG_PATH]);

    const assessment = await evaluateReleaseAuthority(range(PREV), scm);

    expect(assessment.outcome).toBe("sign-off-required");
    expect(assessment.reasonCode).toBe("release_authority_changed");
    expect(assessment.configChanged).toBe(true);
    expect(assessment.addedRequiredWorkflows).toEqual([INTEGRATION]);
    expect(assessment.removedRequiredWorkflows).toEqual([]);
    expect(assessment.changedAuthorityPaths).toEqual([RELEASE_CONFIG_PATH]);
  });

  it("requires sign-off when a workflow OTHER than the configured one changes", async () => {
    const scm = new FakeScm();
    // Config is byte-identical across the range: only a sibling workflow changed.
    scm.seedFileContent({ repository: REPO, commitSha: PREV }, RELEASE_CONFIG_PATH, config(CI));
    scm.seedFileContent({ repository: REPO, commitSha: CAND }, RELEASE_CONFIG_PATH, config(CI));
    // INTEGRATION is a LOCAL reusable workflow NOT named in requiredWorkflows.
    seedRange(scm, PREV, [INTEGRATION, "src/app.ts"]);

    const assessment = await evaluateReleaseAuthority(range(PREV), scm);

    expect(assessment.outcome).toBe("sign-off-required");
    expect(assessment.reasonCode).toBe("release_authority_changed");
    expect(assessment.configChanged).toBe(false);
    expect(assessment.changedAuthorityPaths).toEqual([INTEGRATION]);
  });

  it("requires sign-off when a local composite action changes", async () => {
    const scm = new FakeScm();
    scm.seedFileContent({ repository: REPO, commitSha: PREV }, RELEASE_CONFIG_PATH, config(CI));
    scm.seedFileContent({ repository: REPO, commitSha: CAND }, RELEASE_CONFIG_PATH, config(CI));
    seedRange(scm, PREV, [LOCAL_ACTION, "docs/guide.md"]);

    const assessment = await evaluateReleaseAuthority(range(PREV), scm);

    expect(assessment.outcome).toBe("sign-off-required");
    expect(assessment.reasonCode).toBe("release_authority_changed");
    expect(assessment.configChanged).toBe(false);
    expect(assessment.changedAuthorityPaths).toEqual([LOCAL_ACTION]);
  });

  it("does not treat unrelated source changes as an authority change", async () => {
    const scm = new FakeScm();
    scm.seedFileContent(
      { repository: REPO, commitSha: PREV },
      RELEASE_CONFIG_PATH,
      config(CI, INTEGRATION),
    );
    scm.seedFileContent(
      { repository: REPO, commitSha: CAND },
      RELEASE_CONFIG_PATH,
      config(CI, INTEGRATION),
    );
    // A broad, noisy source change set with a near-miss path that must NOT match.
    seedRange(scm, PREV, [
      "src/server/main.ts",
      "package.json",
      "githubby/workflows/ci.yml", // near-miss: not under .github/
      "src/.github/workflows/ci.yml", // near-miss: not repository-root .github/
    ]);

    const assessment = await evaluateReleaseAuthority(range(PREV), scm);

    expect(assessment.outcome).toBe("clean");
    expect(assessment.changedAuthorityPaths).toEqual([]);
  });
});

describe("invalid repository release config", () => {
  it("is ineligible when the candidate configuration is absent", async () => {
    const scm = new FakeScm();
    // A valid previous baseline exists, but the candidate has no config at all.
    scm.seedFileContent({ repository: REPO, commitSha: PREV }, RELEASE_CONFIG_PATH, config(CI));
    seedRange(scm, PREV, ["src/app.ts"]);

    const assessment = await evaluateReleaseAuthority(range(PREV), scm);

    expect(assessment.outcome).toBe("ineligible");
    expect(assessment.reasonCode).toBe("release_config_missing");
    expect(assessment.candidate).toBeNull();
    // Ineligible is NOT an approvable exception.
    expect(assessment.outcome).not.toBe("sign-off-required");
  });

  it("is ineligible when the candidate configuration is empty", async () => {
    const scm = new FakeScm();
    scm.seedFileContent({ repository: REPO, commitSha: CAND }, RELEASE_CONFIG_PATH, "   \n");

    const assessment = await evaluateReleaseAuthority(range(null), scm);

    expect(assessment.outcome).toBe("ineligible");
    expect(assessment.reasonCode).toBe("release_config_missing");
  });

  it("is ineligible when the candidate configuration is malformed", async () => {
    const scm = new FakeScm();
    scm.seedFileContent(
      { repository: REPO, commitSha: CAND },
      RELEASE_CONFIG_PATH,
      "version: 1\nrequiredWorkflows: []\n",
    );

    const assessment = await evaluateReleaseAuthority(range(null), scm);

    expect(assessment.outcome).toBe("ineligible");
    expect(assessment.reasonCode).toBe("release_config_invalid");
  });

  it("is ineligible when the candidate configuration is self-referential", async () => {
    const scm = new FakeScm();
    scm.seedFileContent(
      { repository: REPO, commitSha: CAND },
      RELEASE_CONFIG_PATH,
      config(".github/workflows/scruffy-release.yml"),
    );

    const assessment = await evaluateReleaseAuthority(range(null), scm);

    expect(assessment.outcome).toBe("ineligible");
    expect(assessment.reasonCode).toBe("release_config_invalid");
  });

  it("ineligibility dominates even with a valid previous baseline and clean range", async () => {
    const scm = new FakeScm();
    scm.seedFileContent({ repository: REPO, commitSha: PREV }, RELEASE_CONFIG_PATH, config(CI));
    // Candidate config is unknown-keyed (weakening attempt) — still ineligible.
    scm.seedFileContent(
      { repository: REPO, commitSha: CAND },
      RELEASE_CONFIG_PATH,
      "version: 1\nrequiredWorkflows:\n  - .github/workflows/ci.yml\nwaive: true\n",
    );
    seedRange(scm, PREV, []);

    const assessment = await evaluateReleaseAuthority(range(PREV), scm);

    expect(assessment.outcome).toBe("ineligible");
    expect(assessment.reasonCode).toBe("release_config_invalid");
  });
});
