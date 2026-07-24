import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, type Harness } from "./boot.js";
import { REPO } from "../fixtures/scenarios.js";
import type { ChangedFile } from "../../src/providers/scm/port.js";

/**
 * End-to-end nightly gate over a seeded RANGE, plus the durable watermark. Real
 * Postgres, fake trust-edge providers, FixedClock. The nightly gate never blocks;
 * it reports and (later) proposes fixes, and it advances a per-(repo, branch)
 * watermark transactionally with the decision.
 */

const BRANCH = "main";
const H1 = "a1".repeat(20);
const H2 = "b2".repeat(20);
const H3 = "c3".repeat(20);
const LEASE_MS = 1_000;

function newFilePatch(lines: string[]): string {
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

// A validated leaked-credential -> reportable, but not a fixable class -> report.
const REPORT_FILE: ChangedFile = {
  path: "src/config.ts",
  patch: newFilePatch(["export const AWS_KEY = 'AKIAIJKLMNOP12345678';"]),
};
// A validated disabled-TLS flag in prod code -> fixable class -> propose_fix.
const FIX_FILE: ChangedFile = {
  path: "src/http.ts",
  patch: newFilePatch(["const agent = new https.Agent({ rejectUnauthorized: false });"]),
};
// The same defect in test code -> validator refutes -> suppress.
const SUPPRESS_FILE: ChangedFile = {
  path: "test/http.test.ts",
  patch: newFilePatch(["const agent = new https.Agent({ rejectUnauthorized: false });"]),
};

let h: Harness;

afterEach(async () => {
  await h.pool.end();
});

function nightlyChecks(sha: string) {
  return h.scm.recordedCheckRuns().filter((c) => c.input.externalId === `nightly:${REPO}:${sha}`);
}

async function summaryOf(head: string) {
  const r = await h.pool.query<{ summary: { reported: number; proposedFixes: number; suppressed: number } }>(
    `select d.summary from nightly_decisions d
       join evaluation_runs r on r.id = d.run_id
      where r.repository = $1 and r.commit_sha = $2 and r.kind = 'nightly'`,
    [REPO, head],
  );
  return r.rows[0]?.summary;
}

describe("nightly gate over a seeded range", () => {
  it("reviews a range: ranks findings, emits one neutral summary check, advances the watermark", async () => {
    h = await bootHarness();
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: null, headSha: H1 }, [REPORT_FILE, FIX_FILE, SUPPRESS_FILE]);

    const res = await h.scruffy.runNightly({ repository: REPO, branch: BRANCH, head: H1 });
    expect(res.reviewed).toBe(true);
    await h.scruffy.flushEffects();

    const checks = nightlyChecks(H1);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.input.conclusion).toBe("neutral"); // nightly never blocks
    expect(checks[0]!.input.title).toMatch(/1 fix proposed/);

    expect(await summaryOf(H1)).toEqual({ reported: 1, proposedFixes: 1, suppressed: 1 });
    expect((await h.scruffy.runs.getWatermark(REPO, BRANCH))?.lastReviewedHead).toBe(H1);
  });

  it("is a no-op when the head is already at the watermark, and advances across the next range", async () => {
    h = await bootHarness();
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: null, headSha: H1 }, [FIX_FILE]);
    await h.scruffy.runNightly({ repository: REPO, branch: BRANCH, head: H1 });
    await h.scruffy.flushEffects();

    // Re-trigger the same head: nothing new, no run, no new effect.
    const again = await h.scruffy.runNightly({ repository: REPO, branch: BRANCH, head: H1 });
    expect(again).toEqual({ reviewed: false, reason: "up-to-date" });
    expect(nightlyChecks(H1)).toHaveLength(1);

    // Next range picks up from the watermark (H1) automatically.
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: H1, headSha: H2 }, [REPORT_FILE]);
    const next = await h.scruffy.runNightly({ repository: REPO, branch: BRANCH, head: H2 });
    expect(next.reviewed).toBe(true);
    await h.scruffy.flushEffects();

    expect(nightlyChecks(H2)).toHaveLength(1);
    expect((await h.scruffy.runs.getWatermark(REPO, BRANCH))?.lastReviewedHead).toBe(H2);
  });

  it("records a decision but does NOT regress the watermark when the reviewed base is stale", async () => {
    h = await bootHarness();
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: null, headSha: H1 }, [FIX_FILE]);
    await h.scruffy.runNightly({ repository: REPO, branch: BRANCH, head: H1 });
    await h.scruffy.flushEffects();

    // Review H3 from a stale base (null) while the watermark is already at H1.
    // The decision is valid and reported, but the guarded advance must not move
    // the watermark backward / off a base it no longer points at.
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: null, headSha: H3 }, [FIX_FILE]);
    const res = await h.scruffy.runNightly({ repository: REPO, branch: BRANCH, head: H3, base: null });
    expect(res.reviewed).toBe(true);
    await h.scruffy.flushEffects();

    expect(nightlyChecks(H3)).toHaveLength(1); // it still reported
    expect(await summaryOf(H3)).toBeDefined(); // decision persisted
    expect((await h.scruffy.runs.getWatermark(REPO, BRANCH))?.lastReviewedHead).toBe(H1); // unchanged
  });

  it("recovers a nightly run whose worker crashed mid-analysis, via the reconciler", async () => {
    h = await bootHarness({ leaseMs: LEASE_MS });
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: null, headSha: H1 }, [FIX_FILE]);

    // Simulate a crash: ensure the nightly run, claim it, then "die".
    const run = await h.scruffy.runs.ensureNightlyRun({ repository: REPO, commitSha: H1 }, BRANCH, null, "policy-v1");
    expect(await h.scruffy.runs.claimForAnalysis(run.id, "worker-that-dies", LEASE_MS)).not.toBeNull();

    expect(await h.scruffy.reconcile()).toBe(0); // lease still valid
    h.clock.advance(LEASE_MS + 1);
    expect(await h.scruffy.reconcile()).toBe(1); // reclaimed + driven
    await h.scruffy.flushEffects();

    expect((await h.scruffy.runs.getRun(run.id))?.state).toBe("decided");
    expect(nightlyChecks(H1)).toHaveLength(1);
    expect((await h.scruffy.runs.getWatermark(REPO, BRANCH))?.lastReviewedHead).toBe(H1);
  });

  it("opens a narrow fix PR for a propose_fix finding, alongside the summary check", async () => {
    h = await bootHarness();
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: null, headSha: H1 }, [FIX_FILE, REPORT_FILE]);

    await h.scruffy.runNightly({ repository: REPO, branch: BRANCH, head: H1 });
    await h.scruffy.flushEffects();

    // The disabled-TLS finding -> one fix PR; the leaked-credential -> report only.
    const prs = h.scm.recordedPullRequests();
    expect(prs).toHaveLength(1);
    // fixBranch now appends a short sha256 of the raw path (anti-collision) before the line suffix.
    expect(prs[0]!.input.branch).toMatch(/^scruffy\/fix\/disabled-tls-verification\/src-http-ts-[0-9a-f]{8}-L1$/);
    expect(prs[0]!.input.subject.commitSha).toBe(H1);
    expect(prs[0]!.input.edits[0]!.replacement).toBe("const agent = new https.Agent({ rejectUnauthorized: true });");
    expect(prs[0]!.input.body).toMatch(/not\*\* auto-merged/);

    // Summary check still emitted; decision records the proposed fix.
    expect(nightlyChecks(H1)).toHaveLength(1);
    expect(await summaryOf(H1)).toEqual({ reported: 1, proposedFixes: 1, suppressed: 0 });
    expect(await h.scruffy.outbox.countPending()).toBe(0);
  });

  it("does not open a duplicate PR when effects are re-dispatched", async () => {
    h = await bootHarness();
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: null, headSha: H1 }, [FIX_FILE]);

    await h.scruffy.runNightly({ repository: REPO, branch: BRANCH, head: H1 });
    await h.scruffy.flushEffects();
    await h.scruffy.flushEffects(); // idempotent: nothing left pending, no second PR

    expect(h.scm.recordedPullRequests()).toHaveLength(1);
    expect(h.scm.recordedPullRequests()[0]!.number).toBe(1);
  });

  it("abandons to indeterminate after retries and leaves the watermark unmoved", async () => {
    h = await bootHarness({ leaseMs: LEASE_MS, maxAttempts: 1 });
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: null, headSha: H1 }, [FIX_FILE]);

    const run = await h.scruffy.runs.ensureNightlyRun({ repository: REPO, commitSha: H1 }, BRANCH, null, "policy-v1");
    await h.scruffy.runs.claimForAnalysis(run.id, "worker-that-dies", LEASE_MS); // attempt = 1
    h.clock.advance(LEASE_MS + 1);

    expect(await h.scruffy.reconcile()).toBe(1);
    await h.scruffy.flushEffects();

    expect((await h.scruffy.runs.getRun(run.id))?.state).toBe("indeterminate");
    const checks = nightlyChecks(H1);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.input.conclusion).toBe("neutral");
    // A range we could not review must be re-reviewable later: no watermark.
    expect(await h.scruffy.runs.getWatermark(REPO, BRANCH)).toBeNull();
  });
});
