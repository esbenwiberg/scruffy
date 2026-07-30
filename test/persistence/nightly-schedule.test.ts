import { afterAll, beforeEach, expect, it } from "vitest";
import { describeDb } from "../support/db.js";
import { createPool } from "../../src/persistence/db.js";
import { migrate } from "../../src/persistence/migrate.js";
import { NightlyScheduleStore } from "../../src/persistence/nightly-schedule.js";

/**
 * The SQL behind the hosted nightly schedule. `test/app/nightly-scheduler.test.ts`
 * proves the scheduler's USE of this port against an in-memory double; this suite is
 * the authority on the one statement everything else trusts — the atomic
 * "unleased-or-expired AND owed" claim.
 */

const pool = createPool();
const REPO = "acme/api";
const BRANCH = "trunk";
const T0 = new Date("2026-03-01T02:00:00.000Z");
const CADENCE_MS = 24 * 60 * 60_000;
const LEASE_MS = 30 * 60_000;

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

describeDb("NightlyScheduleStore", () => {
  const store = new NightlyScheduleStore(pool);

  beforeEach(async () => {
    await migrate(pool);
    await pool.query("delete from nightly_schedule_state where repository = $1", [REPO]);
  });

  afterAll(async () => {
    await pool.query("delete from nightly_schedule_state where repository = $1", [REPO]);
    await pool.end();
  });

  const claim = (now: Date, owner = "worker-a") =>
    store.claim({ repository: REPO, branch: BRANCH, owner, now, leaseMs: LEASE_MS, dueBefore: new Date(now.getTime() - CADENCE_MS) });

  it("grants a never-scheduled branch and records the attempt", async () => {
    const granted = await claim(T0);
    expect(granted).not.toBeNull();
    const state = await store.get(REPO, BRANCH);
    expect(state).toMatchObject({ leaseOwner: "worker-a", attempts: 1, lastOutcome: null, lastScheduledHead: null });
    expect(state?.leaseExpiresAt?.getTime()).toBe(at(LEASE_MS).getTime());
  });

  it("refuses a second concurrent claim, then releases and records the outcome", async () => {
    const first = await claim(T0);
    expect(await claim(at(1_000), "worker-b")).toBeNull();

    const released = await store.release({
      repository: REPO,
      branch: BRANCH,
      leaseId: first!.leaseId,
      now: at(2_000),
      head: "a".repeat(40),
      outcome: "reviewed",
      error: null,
    });
    expect(released).toBe(true);
    expect(await store.get(REPO, BRANCH)).toMatchObject({
      leaseOwner: null,
      leaseExpiresAt: null,
      lastOutcome: "reviewed",
      lastScheduledHead: "a".repeat(40),
      lastError: null,
    });
  });

  it("holds a COMPLETED attempt for its cadence window, then grants again", async () => {
    const first = await claim(T0);
    await store.release({
      repository: REPO,
      branch: BRANCH,
      leaseId: first!.leaseId,
      now: at(1_000),
      head: "a".repeat(40),
      outcome: "reviewed",
      error: null,
    });

    // Lease is free, but the cadence is not up: a finished night is not owed.
    expect(await claim(at(LEASE_MS + 1_000))).toBeNull();
    expect(await claim(at(CADENCE_MS))).not.toBeNull();
    expect((await store.get(REPO, BRANCH))?.attempts).toBe(2);
  });

  it("grants an OUTSTANDING attempt as soon as its lease expires — a crash must not cost a whole night", async () => {
    await claim(T0); // claimed and never released: the process died mid-run
    expect(await claim(at(LEASE_MS - 1))).toBeNull();

    const recovered = await claim(at(LEASE_MS + 1), "worker-b");
    expect(recovered).not.toBeNull();
    expect(await store.get(REPO, BRANCH)).toMatchObject({ leaseOwner: "worker-b", attempts: 2 });
  });

  it("treats a LATER outstanding attempt as owed even when an earlier one finished", async () => {
    const first = await claim(T0);
    await store.release({
      repository: REPO,
      branch: BRANCH,
      leaseId: first!.leaseId,
      now: at(1_000),
      head: "a".repeat(40),
      outcome: "reviewed",
      error: null,
    });
    // Next window's attempt crashes: `last_finished_at` is stale, not null, so the
    // predicate has to compare it against `last_started_at` rather than null-check it.
    await claim(at(CADENCE_MS));
    expect(await claim(at(CADENCE_MS + LEASE_MS + 1))).not.toBeNull();
  });

  it("does not let a fenced loser clear a lease that was taken over", async () => {
    const first = await claim(T0);
    const takeover = await claim(at(LEASE_MS + 1), "worker-b");
    expect(takeover).not.toBeNull();

    // The crashed worker comes back to life and tries to release: it no longer owns
    // the branch, so its late write must not clobber the new owner's lease.
    const late = await store.release({
      repository: REPO,
      branch: BRANCH,
      leaseId: first!.leaseId,
      now: at(LEASE_MS + 2),
      head: null,
      outcome: "failed",
      error: "stale worker",
    });
    expect(late).toBe(false);
    expect(await store.get(REPO, BRANCH)).toMatchObject({ leaseOwner: "worker-b", lastOutcome: null });
  });

  it("returns null for a branch that was never scheduled", async () => {
    expect(await store.get(REPO, "other-branch")).toBeNull();
  });
});
