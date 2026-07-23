import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, type Harness } from "./boot.js";
import { REPO } from "../fixtures/scenarios.js";
import type { ChangedFile } from "../../src/providers/scm/port.js";
import type { ReleaseOutcome } from "../../src/gates/release/decision.js";

/**
 * End-to-end release gate over a seeded RANGE (prev-release, candidate]. Real
 * Postgres, fake trust-edge providers, FixedClock. The release gate produces one
 * aggregate outcome (ship | sign-off-required | stop | indeterminate); in the
 * skeleton it is shadow-first — the emitted check is always neutral and never
 * blocks publication, while the true outcome is recorded in release_decisions.
 */

const PREV = "a1".repeat(20); // previous release sha
const CAND = "b2".repeat(20); // candidate sha
const CAND2 = "c3".repeat(20);
const LEASE_MS = 1_000;

function newFilePatch(lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

// A live-looking AWS key in prod -> confirmed leaked-credential -> STOP.
const SECRET_FILE: ChangedFile = {
  path: "src/config.ts",
  patch: newFilePatch(["export const AWS_KEY = 'AKIAIJKLMNOP12345678';"]),
};
// A validated disabled-TLS flag in prod -> sign-off class -> SIGN-OFF-REQUIRED.
const TLS_FILE: ChangedFile = {
  path: "src/http.ts",
  patch: newFilePatch(["const agent = new https.Agent({ rejectUnauthorized: false });"]),
};
// Ordinary change -> no finding -> SHIP.
const CLEAN_FILE: ChangedFile = {
  path: "src/total.ts",
  patch: newFilePatch(["export const total = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);"]),
};

let h: Harness;

afterEach(async () => {
  await h.pool.end();
});

function releaseChecks(sha: string) {
  return h.scm.recordedCheckRuns().filter((c) => c.input.externalId === `release:${REPO}:${sha}`);
}

async function decisionOf(candidate: string) {
  const r = await h.pool.query<{ outcome: ReleaseOutcome; summary: { stopped: number; escalated: number; cleared: number; notRelevant: number } }>(
    `select d.outcome, d.summary from release_decisions d
       join evaluation_runs r on r.id = d.run_id
      where r.repository = $1 and r.commit_sha = $2 and r.kind = 'release'`,
    [REPO, candidate],
  );
  return r.rows[0];
}

describe("release gate over a seeded range", () => {
  it("STOPS a range that ships a confirmed leaked credential, recording an advisory neutral check", async () => {
    h = await bootHarness();
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: CAND }, [SECRET_FILE, CLEAN_FILE]);

    const run = await h.scruffy.runRelease({ repository: REPO, candidate: CAND, prevRelease: PREV });
    expect(run.state).toBe("decided");
    await h.scruffy.flushEffects();

    const decision = await decisionOf(CAND);
    expect(decision?.outcome).toBe("stop");
    expect(decision?.summary.stopped).toBe(1);

    const checks = releaseChecks(CAND);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.input.conclusion).toBe("neutral"); // shadow-first: never blocks publication yet
    expect(checks[0]!.input.title).toMatch(/STOP/);
  });

  it("requires SIGN-OFF for a prod disabled-TLS regression (serious but human-adjudicable)", async () => {
    h = await bootHarness();
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: CAND }, [TLS_FILE]);

    const run = await h.scruffy.runRelease({ repository: REPO, candidate: CAND, prevRelease: PREV });
    expect(run.state).toBe("decided");
    await h.scruffy.flushEffects();

    expect((await decisionOf(CAND))?.outcome).toBe("sign-off-required");
    const checks = releaseChecks(CAND);
    expect(checks[0]!.input.conclusion).toBe("neutral");
    expect(checks[0]!.input.title).toMatch(/sign-off required/);
  });

  it("SHIPS a clean range", async () => {
    h = await bootHarness();
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: CAND }, [CLEAN_FILE]);

    await h.scruffy.runRelease({ repository: REPO, candidate: CAND, prevRelease: PREV });
    await h.scruffy.flushEffects();

    expect((await decisionOf(CAND))?.outcome).toBe("ship");
    expect(releaseChecks(CAND)[0]!.input.title).toMatch(/ship/);
  });

  it("reviews a first-ever release (null prev-release) as the candidate's own change set", async () => {
    h = await bootHarness();
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: null, headSha: CAND }, [SECRET_FILE]);

    await h.scruffy.runRelease({ repository: REPO, candidate: CAND, prevRelease: null });
    await h.scruffy.flushEffects();

    expect((await decisionOf(CAND))?.outcome).toBe("stop");
    expect(releaseChecks(CAND)).toHaveLength(1);
  });

  it("is idempotent: re-triggering the same candidate does not re-decide or duplicate the check", async () => {
    h = await bootHarness();
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: CAND }, [TLS_FILE]);

    await h.scruffy.runRelease({ repository: REPO, candidate: CAND, prevRelease: PREV });
    await h.scruffy.flushEffects();

    // Second trigger: the run is already terminal, so it is a no-op reconcile.
    const again = await h.scruffy.runRelease({ repository: REPO, candidate: CAND, prevRelease: PREV });
    expect(again.state).toBe("decided");
    await h.scruffy.flushEffects();
    await h.scruffy.flushEffects();

    expect(releaseChecks(CAND)).toHaveLength(1);
  });

  it("recovers a release run whose worker crashed mid-analysis, via the reconciler", async () => {
    h = await bootHarness({ leaseMs: LEASE_MS });
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: CAND }, [SECRET_FILE]);

    // Simulate a crash: ensure the release run, claim it, then "die".
    const run = await h.scruffy.runs.ensureReleaseRun({ repository: REPO, commitSha: CAND }, PREV, "policy-v1");
    expect(await h.scruffy.runs.claimForAnalysis(run.id, "worker-that-dies", LEASE_MS)).not.toBeNull();

    expect(await h.scruffy.reconcile()).toBe(0); // lease still valid
    h.clock.advance(LEASE_MS + 1);
    expect(await h.scruffy.reconcile()).toBe(1); // reclaimed + driven
    await h.scruffy.flushEffects();

    expect((await h.scruffy.runs.getRun(run.id))?.state).toBe("decided");
    expect((await decisionOf(CAND))?.outcome).toBe("stop");
    expect(releaseChecks(CAND)).toHaveLength(1);
  });

  it("abandons to indeterminate after retries — never a fabricated ship or stop", async () => {
    h = await bootHarness({ leaseMs: LEASE_MS, maxAttempts: 1 });
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: CAND2 }, [SECRET_FILE]);

    const run = await h.scruffy.runs.ensureReleaseRun({ repository: REPO, commitSha: CAND2 }, PREV, "policy-v1");
    await h.scruffy.runs.claimForAnalysis(run.id, "worker-that-dies", LEASE_MS); // attempt = 1
    h.clock.advance(LEASE_MS + 1);

    expect(await h.scruffy.reconcile()).toBe(1);
    await h.scruffy.flushEffects();

    expect((await h.scruffy.runs.getRun(run.id))?.state).toBe("indeterminate");
    expect((await decisionOf(CAND2))?.outcome).toBe("indeterminate");
    const checks = releaseChecks(CAND2);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.input.conclusion).toBe("neutral");
  });
});
