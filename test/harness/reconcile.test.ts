import { afterEach, describe, expect, it } from "vitest";
import { bootHarness, type Harness } from "./boot.js";
import { REPO, SCENARIOS } from "../fixtures/scenarios.js";

/**
 * ADR 0003 validation #4 (the durable half): work is recovered independently of
 * webhook delivery. These tests simulate a crashed worker by claiming a run and
 * then never finishing it, advancing the clock past the lease, and letting the
 * reconciler take over.
 */

const LEASE_MS = 1_000;

let h: Harness;

afterEach(async () => {
  await h.pool.end();
});

function checksFor(h: Harness, sha: string) {
  return h.scm.recordedCheckRuns().filter((c) => c.input.subject.commitSha === sha);
}

describe("reconciliation", () => {
  it("recovers a run whose worker crashed mid-analysis (analyzing + expired lease)", async () => {
    h = await bootHarness({ leaseMs: LEASE_MS });
    const scenario = SCENARIOS.realSecret!;
    const subject = { repository: REPO, commitSha: scenario.commitSha };
    h.scm.seedChangedFiles(subject, scenario.files);

    // Simulate a crash: claim the run for analysis, then "die" before deciding.
    const run = await h.scruffy.runs.ensureRun(subject, "poison", "policy-v1");
    expect(await h.scruffy.runs.claimForAnalysis(run.id, "worker-that-dies", LEASE_MS)).not.toBeNull();

    // Before the lease expires, the run is NOT reconcilable.
    expect(await h.scruffy.reconcile()).toBe(0);

    // Lease expires; reconciler reclaims and completes it.
    h.clock.advance(LEASE_MS + 1);
    expect(await h.scruffy.reconcile()).toBe(1);
    await h.scruffy.flushEffects();

    expect((await h.scruffy.runs.getRun(run.id))?.state).toBe("decided");
    const checks = checksFor(h, scenario.commitSha);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.input.conclusion).toBe("failure"); // the secret still blocks
  });

  it("drives a run stuck in pending (webhook handler died before claiming)", async () => {
    h = await bootHarness({ leaseMs: LEASE_MS });
    const scenario = SCENARIOS.clean!;
    const subject = { repository: REPO, commitSha: scenario.commitSha };
    h.scm.seedChangedFiles(subject, scenario.files);

    await h.scruffy.runs.ensureRun(subject, "poison", "policy-v1"); // pending, never claimed
    expect(await h.scruffy.reconcile()).toBe(1);
    await h.scruffy.flushEffects();

    const checks = checksFor(h, scenario.commitSha);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.input.conclusion).toBe("success");
  });

  it("abandons to indeterminate after attempts are exhausted — never a fabricated verdict", async () => {
    h = await bootHarness({ leaseMs: LEASE_MS, maxAttempts: 1 });
    const scenario = SCENARIOS.realSecret!;
    const subject = { repository: REPO, commitSha: scenario.commitSha };
    h.scm.seedChangedFiles(subject, scenario.files);

    // One attempt already made, then crashed.
    const run = await h.scruffy.runs.ensureRun(subject, "poison", "policy-v1");
    await h.scruffy.runs.claimForAnalysis(run.id, "worker-that-dies", LEASE_MS); // attempt = 1
    h.clock.advance(LEASE_MS + 1);

    expect(await h.scruffy.reconcile()).toBe(1);
    await h.scruffy.flushEffects();

    expect((await h.scruffy.runs.getRun(run.id))?.state).toBe("indeterminate");
    const checks = checksFor(h, scenario.commitSha);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.input.conclusion).toBe("neutral");
    expect(checks[0]!.input.title).toMatch(/retries exhausted/);
  });

  it("does not duplicate effects when a late webhook arrives after reconciliation", async () => {
    h = await bootHarness({ leaseMs: LEASE_MS });
    const scenario = SCENARIOS.realSecret!;
    const subject = { repository: REPO, commitSha: scenario.commitSha };
    h.scm.seedChangedFiles(subject, scenario.files);

    const run = await h.scruffy.runs.ensureRun(subject, "poison", "policy-v1");
    await h.scruffy.runs.claimForAnalysis(run.id, "worker-that-dies", LEASE_MS);
    h.clock.advance(LEASE_MS + 1);
    await h.scruffy.reconcile();
    await h.scruffy.flushEffects();

    // The delayed webhook finally lands; the run is already terminal.
    const body = JSON.stringify({ action: "opened", repository: { full_name: REPO }, pull_request: { head: { sha: scenario.commitSha } } });
    const { sign } = await import("@octokit/webhooks-methods");
    await h.scruffy.handleWebhook(await sign("test-secret", body), body);
    await h.scruffy.flushEffects();

    expect(checksFor(h, scenario.commitSha)).toHaveLength(1);
    expect(await h.scruffy.outbox.countPending()).toBe(0);
  });
});
