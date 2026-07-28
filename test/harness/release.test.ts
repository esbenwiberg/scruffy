import { afterEach, expect, it } from "vitest";
import { describeDb } from "../support/db.js";
import { bootHarness, type Harness } from "./boot.js";
import { REPO } from "../fixtures/scenarios.js";
import type { CandidateCiEvidence, CandidateCiState, ChangedFile } from "../../src/providers/scm/port.js";
import type { ReleaseOutcome } from "../../src/gates/release/decision.js";
import { parseReleaseReport } from "../../src/domain/release/report.js";
import { HARNESS_REQUIRED_CI_CONTEXTS } from "./boot.js";

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

const [CI_BUILD, CI_TESTS] = HARNESS_REQUIRED_CI_CONTEXTS;

/** Candidate-CI evidence bound to a candidate SHA, one record per (context, state). */
function ciEvidence(sha: string, entries: { context: string; state: CandidateCiState; updatedAt?: string }[]): CandidateCiEvidence {
  return {
    sha,
    records: entries.map((e) => ({
      context: e.context,
      state: e.state,
      sha,
      source: "check-run" as const,
      ...(e.updatedAt ? { updatedAt: e.updatedAt } : {}),
    })),
  };
}

/** Every required context passing for the candidate — the only clean candidate-CI state. */
function passingCi(sha: string): CandidateCiEvidence {
  return ciEvidence(
    sha,
    HARNESS_REQUIRED_CI_CONTEXTS.map((context) => ({ context, state: "success" as CandidateCiState })),
  );
}

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

/** All persisted release_reports rows for a candidate, with the jsonb blob re-parsed at the read boundary. */
async function reportsOf(candidate: string) {
  const r = await h.pool.query<{ report_id: string; candidate_sha: string; report: unknown }>(
    `select rr.report_id, rr.candidate_sha, rr.report from release_reports rr
       join evaluation_runs r on r.id = rr.run_id
      where r.repository = $1 and r.commit_sha = $2 and r.kind = 'release'`,
    [REPO, candidate],
  );
  // Never trust the blob: re-validate every stored report through the schema.
  return r.rows.map((row) => ({ reportId: row.report_id, candidateShaColumn: row.candidate_sha, report: parseReleaseReport(row.report) }));
}

describeDb("release gate over a seeded range", () => {
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
    // A required candidate-CI lane must be complete to ship: seed every named
    // context passing for the exact candidate. Without this, ship is impossible.
    h.scm.seedCandidateCi({ repository: REPO, commitSha: CAND }, passingCi(CAND));

    await h.scruffy.runRelease({ repository: REPO, candidate: CAND, prevRelease: PREV });
    await h.scruffy.flushEffects();

    expect((await decisionOf(CAND))?.outcome).toBe("ship");
    expect(releaseChecks(CAND)[0]!.input.title).toMatch(/ship/);
  });

  it("missing or non-success required CI forces sign-off", async () => {
    h = await bootHarness();

    // Distinct candidate SHAs so each scenario is an independent release run under
    // one boot. Every range is otherwise CLEAN — only candidate CI can hold it, so
    // any non-ship outcome is attributable to the CI lane alone.
    const candFor = (i: number): string => i.toString(16).padStart(2, "0").repeat(20);

    // Every listed unsafe state on a required context (ci/build), with ci/tests
    // passing, must PREVENT ship. `unknown` stands in for malformed CI evidence.
    const unsafeStates: CandidateCiState[] = [
      "pending",
      "failure",
      "cancelled",
      "timed-out",
      "neutral",
      "action-required",
      "error",
      "unknown",
    ];

    let i = 0;
    for (const state of unsafeStates) {
      const cand = candFor(i++);
      h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: cand }, [CLEAN_FILE]);
      h.scm.seedCandidateCi(
        { repository: REPO, commitSha: cand },
        ciEvidence(cand, [
          { context: CI_BUILD!, state },
          { context: CI_TESTS!, state: "success" },
        ]),
      );
      await h.scruffy.runRelease({ repository: REPO, candidate: cand, prevRelease: PREV });
      expect((await decisionOf(cand))?.outcome, `CI state ${state} must not ship`).toBe("sign-off-required");
    }

    // A MISSING required context (only the other one present) cannot ship.
    const missing = candFor(i++);
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: missing }, [CLEAN_FILE]);
    h.scm.seedCandidateCi({ repository: REPO, commitSha: missing }, ciEvidence(missing, [{ context: CI_TESTS!, state: "success" }]));
    await h.scruffy.runRelease({ repository: REPO, candidate: missing, prevRelease: PREV });
    expect((await decisionOf(missing))?.outcome).toBe("sign-off-required");

    // EXTRA unrelated successful contexts cannot substitute for a required one:
    // ci/tests passes, ci/build is absent, an unrelated context passes -> sign-off.
    const extra = candFor(i++);
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: extra }, [CLEAN_FILE]);
    h.scm.seedCandidateCi(
      { repository: REPO, commitSha: extra },
      ciEvidence(extra, [
        { context: CI_TESTS!, state: "success" },
        { context: "unrelated/thing", state: "success" },
      ]),
    );
    await h.scruffy.runRelease({ repository: REPO, candidate: extra, prevRelease: PREV });
    expect((await decisionOf(extra))?.outcome).toBe("sign-off-required");

    // A DUPLICATE-AMBIGUOUS required context (two records, differing states, no clear
    // latest) is not clean -> sign-off, even with the other context passing.
    const ambiguous = candFor(i++);
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: ambiguous }, [CLEAN_FILE]);
    h.scm.seedCandidateCi(
      { repository: REPO, commitSha: ambiguous },
      ciEvidence(ambiguous, [
        { context: CI_BUILD!, state: "success" },
        { context: CI_BUILD!, state: "failure" },
        { context: CI_TESTS!, state: "success" },
      ]),
    );
    await h.scruffy.runRelease({ repository: REPO, candidate: ambiguous, prevRelease: PREV });
    expect((await decisionOf(ambiguous))?.outcome).toBe("sign-off-required");

    // Control: EVERY required context passing for the exact candidate ships.
    const clean = candFor(i++);
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: clean }, [CLEAN_FILE]);
    h.scm.seedCandidateCi({ repository: REPO, commitSha: clean }, passingCi(clean));
    await h.scruffy.runRelease({ repository: REPO, candidate: clean, prevRelease: PREV });
    expect((await decisionOf(clean))?.outcome).toBe("ship");
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

  it("atomically persists a SHA-bound release report", async () => {
    h = await bootHarness();
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: CAND }, [CLEAN_FILE]);
    h.scm.seedCandidateCi({ repository: REPO, commitSha: CAND }, passingCi(CAND));

    const run = await h.scruffy.runRelease({ repository: REPO, candidate: CAND, prevRelease: PREV });
    expect(run.state).toBe("decided");
    await h.scruffy.flushEffects();

    // Exactly one schema-valid report, bound to the immutable range.
    const reports = await reportsOf(CAND);
    expect(reports).toHaveLength(1);
    const { report, reportId, candidateShaColumn } = reports[0]!;
    expect(report.reportVersion).toBe("1");
    expect(report.subject.candidateSha).toBe(CAND);
    expect(report.subject.previousReleaseSha).toBe(PREV);
    expect(candidateShaColumn).toBe(CAND); // denormalized column agrees with the blob
    // Every policy-declared lane appears; the candidate-CI lane binds the exact SHA.
    expect(report.evidenceLanes.map((l) => l.laneId)).toEqual(["source-analysis", "candidate-ci"]);
    expect(report.evidenceLanes.every((l) => l.subjectSha === CAND)).toBe(true);
    const ciLane = report.evidenceLanes.find((l) => l.laneId === "candidate-ci")!;
    expect(ciLane.status).toBe("complete");
    expect(ciLane.required).toBe(true);

    // Report, durable decision, and posted check all agree.
    const decision = await decisionOf(CAND);
    expect(report.decision.outcome).toBe("ship");
    expect(decision?.outcome).toBe(report.decision.outcome);

    const checks = releaseChecks(CAND);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.input.conclusion).toBe("neutral"); // shadow-first
    // The check is rendered FROM the report: it carries the same report id + candidate + outcome.
    expect(checks[0]!.input.summary).toContain(reportId);
    expect(checks[0]!.input.summary).toContain(CAND);
    expect(checks[0]!.input.title).toMatch(/ship/);
  });

  it("does not duplicate a release report", async () => {
    h = await bootHarness();
    h.scm.seedChangedFilesInRange({ repository: REPO, baseSha: PREV, headSha: CAND }, [TLS_FILE]);

    await h.scruffy.runRelease({ repository: REPO, candidate: CAND, prevRelease: PREV });
    await h.scruffy.flushEffects();

    // Re-trigger the same immutable candidate + policy, and flush repeatedly.
    const again = await h.scruffy.runRelease({ repository: REPO, candidate: CAND, prevRelease: PREV });
    expect(again.state).toBe("decided");
    await h.scruffy.flushEffects();
    await h.scruffy.flushEffects();

    // One report, one idempotent check effect — a retry never inserts a second.
    expect(await reportsOf(CAND)).toHaveLength(1);
    expect(releaseChecks(CAND)).toHaveLength(1);
    const rows = await h.pool.query<{ count: string }>(
      `select count(*) from outbox o join evaluation_runs r on r.id = o.run_id
        where r.repository = $1 and r.commit_sha = $2 and r.kind = 'release'`,
      [REPO, CAND],
    );
    expect(rows.rows[0]!.count).toBe("1");
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
