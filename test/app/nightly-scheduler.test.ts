import { describe, expect, it } from "vitest";
import { FixedClock } from "../../src/platform/clock.js";
import { NightlyScheduler, type NightlyReviewTrigger } from "../../src/app/nightly-scheduler.js";
import type {
  ClaimScheduleInput,
  NightlyScheduleClaim,
  NightlySchedulePort,
  NightlyScheduleState,
  ReleaseScheduleInput,
} from "../../src/persistence/nightly-schedule.js";
import { FakeScm } from "../../src/providers/scm/fake.js";

/**
 * The hosted nightly TRIGGER, on a fake clock.
 *
 * What these tests are really defending is the difference between "we reviewed the
 * installation" and "we reviewed whatever we happened to reach". So they assert on
 * the negatives as hard as the positives: no `main` assumption, no repository
 * outside the installation, no head taken from anywhere but the read credential,
 * no clean-looking tick after a provider fault, and no second nightly run when two
 * ticks (or a restart) race for the same branch.
 *
 * `MemorySchedule` re-implements the store's claim predicate rather than being a
 * permissive map: the all-or-nothing "unleased-or-expired AND due" check IS the
 * overlap protection under test. `test/persistence`'s DB-gated suite proves the SQL
 * itself; this suite proves the scheduler's use of it, on every `npm test` run.
 */

interface Row {
  repository: string;
  branch: string;
  leaseOwner: string | null;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastScheduledHead: string | null;
  lastOutcome: string | null;
  lastError: string | null;
  attempts: number;
}

class MemorySchedule implements NightlySchedulePort {
  readonly #rows = new Map<string, Row>();
  /** Every granted claim, so a test can count attempts across ticks and restarts. */
  readonly grants: { repository: string; branch: string; leaseId: string }[] = [];
  #seq = 0;

  async claim(input: ClaimScheduleInput): Promise<NightlyScheduleClaim | null> {
    const key = `${input.repository}#${input.branch}`;
    const row = this.#rows.get(key);
    const leaseFree = row === undefined || row.leaseExpiresAt === null || row.leaseExpiresAt.getTime() <= input.now.getTime();
    const dueByCadence = row === undefined || row.lastStartedAt === null || row.lastStartedAt.getTime() <= input.dueBefore.getTime();
    // An attempt that was claimed and never released is OUTSTANDING (the process
    // died): owed as soon as its lease expires, not a whole cadence later.
    const outstanding =
      row !== undefined &&
      row.lastStartedAt !== null &&
      (row.lastFinishedAt === null || row.lastFinishedAt.getTime() < row.lastStartedAt.getTime());
    if (!leaseFree || !(dueByCadence || outstanding)) return null;
    this.#seq += 1;
    const leaseId = `${input.owner}:${this.#seq}`;
    this.#rows.set(key, {
      repository: input.repository,
      branch: input.branch,
      leaseOwner: input.owner,
      leaseId,
      leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
      lastStartedAt: input.now,
      lastFinishedAt: row?.lastFinishedAt ?? null,
      lastScheduledHead: row?.lastScheduledHead ?? null,
      lastOutcome: row?.lastOutcome ?? null,
      lastError: row?.lastError ?? null,
      attempts: (row?.attempts ?? 0) + 1,
    });
    this.grants.push({ repository: input.repository, branch: input.branch, leaseId });
    return { repository: input.repository, branch: input.branch, leaseId };
  }

  async release(input: ReleaseScheduleInput): Promise<boolean> {
    const row = this.#rows.get(`${input.repository}#${input.branch}`);
    // Fenced exactly like the SQL: a lease that expired and was taken over by
    // another worker must not be cleared by the loser's late release.
    if (row === undefined || row.leaseId !== input.leaseId) return false;
    row.leaseOwner = null;
    row.leaseId = null;
    row.leaseExpiresAt = null;
    row.lastFinishedAt = input.now;
    row.lastScheduledHead = input.head;
    row.lastOutcome = input.outcome;
    row.lastError = input.error;
    return true;
  }

  async get(repository: string, branch: string): Promise<NightlyScheduleState | null> {
    const row = this.#rows.get(`${repository}#${branch}`);
    return row === undefined ? null : { ...row };
  }
}

/** Records every nightly range it was asked to review. */
class RecordingTrigger implements NightlyReviewTrigger {
  readonly calls: { repository: string; branch: string; head: string }[] = [];
  /** Heads already reviewed to a complete watermark — a repeat is `reviewed: false`. */
  readonly #watermarks = new Map<string, string>();
  #fail: { repository: string; reason: string } | null = null;
  #hang: (() => void) | null = null;

  failOnce(repository: string, reason: string): void {
    this.#fail = { repository, reason };
  }

  /** Make the next call never settle, so a test can hold a lease open mid-run. */
  hangNext(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#hang = resolve;
    });
  }

  async runNightly(input: { repository: string; branch: string; head: string }): Promise<{ reviewed: boolean }> {
    this.calls.push({ ...input });
    if (this.#fail?.repository === input.repository) {
      const reason = this.#fail.reason;
      this.#fail = null;
      throw new Error(reason);
    }
    if (this.#hang !== null) {
      const resolve = this.#hang;
      this.#hang = null;
      resolve();
      // Simulates a process that died mid-run: the attempt never completes, so its
      // lease is only ever freed by expiry.
      return new Promise<{ reviewed: boolean }>(() => {});
    }
    const key = `${input.repository}#${input.branch}`;
    const reviewed = this.#watermarks.get(key) !== input.head;
    this.#watermarks.set(key, input.head);
    return { reviewed };
  }
}

const START = new Date("2026-03-01T02:00:00.000Z");
const CADENCE_MS = 24 * 60 * 60_000;
const LEASE_MS = 30 * 60_000;

function build(options: { cadenceMs?: number; leaseMs?: number; batchSize?: number } = {}): {
  scm: FakeScm;
  schedule: MemorySchedule;
  trigger: RecordingTrigger;
  clock: FixedClock;
  logs: string[];
  scheduler: NightlyScheduler;
} {
  const scm = new FakeScm();
  const schedule = new MemorySchedule();
  const trigger = new RecordingTrigger();
  const clock = new FixedClock(START);
  const logs: string[] = [];
  const scheduler = new NightlyScheduler({
    installations: scm,
    schedule,
    trigger,
    clock,
    cadenceMs: options.cadenceMs ?? CADENCE_MS,
    leaseMs: options.leaseMs ?? LEASE_MS,
    owner: "test-worker",
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
    log: (message) => logs.push(message),
  });
  return { scm, schedule, trigger, clock, logs, scheduler };
}

describe("NightlyScheduler", () => {
  it("schedules installed repositories at resolved default branch heads", async () => {
    const { scm, schedule, trigger, scheduler } = build();
    // Three installed repositories, NONE of them on `main`, plus one archived: the
    // default branch is a provider fact per repository, and archived work is not
    // reviewable work.
    scm.seedInstalledRepositories([
      { repository: "acme/api", defaultBranch: "trunk" },
      { repository: "acme/web", defaultBranch: "develop" },
      { repository: "acme/legacy", defaultBranch: "release/1.x", archived: true },
    ]);
    scm.seedBranch("acme/api", "trunk", "a".repeat(40), "api head");
    scm.seedBranch("acme/web", "develop", "b".repeat(40), "web head");
    // A repository OUTSIDE the installation, with a `main` branch that the
    // scheduler must never reach for even though it exists in the fake.
    scm.seedBranch("acme/not-installed", "main", "c".repeat(40), "unrelated head");

    const tick = await scheduler.tick();

    expect(tick.listingError).toBeNull();
    expect(tick.listed).toBe(3);
    expect(tick.eligible).toBe(2);
    expect(tick.claimed).toBe(2);
    expect(tick.reviewed).toBe(2);

    // Each review ran at the head the READ CREDENTIAL resolved for that
    // repository's own default branch — no `main`, no caller-supplied head.
    expect(trigger.calls).toEqual([
      { repository: "acme/api", branch: "trunk", head: "a".repeat(40) },
      { repository: "acme/web", branch: "develop", head: "b".repeat(40) },
    ]);
    expect(trigger.calls.map((c) => c.branch)).not.toContain("main");
    expect(trigger.calls.map((c) => c.repository)).not.toContain("acme/not-installed");

    // The archived repository is reported as skipped work, not silently dropped.
    const archived = tick.outcomes.find((o) => o.repository === "acme/legacy");
    expect(archived).toMatchObject({ status: "skipped", head: null, branch: "release/1.x" });

    // Every claimed lease was released with its outcome and immutable head, so the
    // next window can tell "attempted" from "never reached".
    const api = await schedule.get("acme/api", "trunk");
    expect(api).toMatchObject({
      leaseId: null,
      leaseExpiresAt: null,
      lastOutcome: "reviewed",
      lastScheduledHead: "a".repeat(40),
      lastError: null,
      attempts: 1,
    });
    expect(await schedule.get("acme/legacy", "release/1.x")).toBeNull();
    expect(await schedule.get("acme/not-installed", "main")).toBeNull();
  });

  it("recovers without duplicate nightly work", async () => {
    const { scm, schedule, trigger, clock, scheduler } = build();
    scm.seedInstalledRepositories([{ repository: "acme/api", defaultBranch: "trunk" }]);
    scm.seedBranch("acme/api", "trunk", "a".repeat(40), "api head");

    // A process that dies mid-run: the nightly never settles, so its lease is only
    // ever freed by expiry.
    const started = trigger.hangNext();
    const crashed = scheduler.tick();
    await started;

    // A restarted process (or a second replica) ticking inside the lease window
    // finds the branch owned and does NOT start a second nightly.
    const duringLease = await scheduler.tick();
    expect(duringLease.claimed).toBe(0);
    expect(duringLease.outcomes[0]).toMatchObject({ status: "deferred" });
    expect(trigger.calls).toHaveLength(1);

    // Once the lease expires the branch is recoverable, and the recovery reviews
    // the SAME immutable head — one range, one report identity, so nothing external
    // is duplicated by the re-drive.
    clock.advance(LEASE_MS + 1_000);
    const recovered = await scheduler.tick();
    expect(recovered.claimed).toBe(1);
    expect(trigger.calls).toHaveLength(2);
    expect(trigger.calls[1]).toEqual({ repository: "acme/api", branch: "trunk", head: "a".repeat(40) });
    // The recovery is the FIRST completed review of that head, so it reviewed.
    expect(recovered.reviewed).toBe(1);
    expect(recovered.outcomes[0]).toMatchObject({ status: "reviewed", head: "a".repeat(40) });

    // A further tick in the same cadence window re-drives nothing at all.
    const settled = await scheduler.tick();
    expect(settled.claimed).toBe(0);
    expect(trigger.calls).toHaveLength(2);

    // And in the NEXT cadence window, an unchanged head is recognised as already
    // reviewed to the complete watermark instead of producing a second report.
    clock.advance(CADENCE_MS);
    const nextNight = await scheduler.tick();
    expect(nextNight.claimed).toBe(1);
    expect(nextNight.reviewed).toBe(0);
    expect(nextNight.outcomes[0]).toMatchObject({ status: "up-to-date" });
    expect(schedule.grants).toHaveLength(3);

    void crashed; // the crashed attempt is intentionally never awaited
  });

  it("does not start two nightly runs when timer ticks overlap", async () => {
    const { scm, trigger, scheduler } = build();
    scm.seedInstalledRepositories([{ repository: "acme/api", defaultBranch: "trunk" }]);
    scm.seedBranch("acme/api", "trunk", "a".repeat(40), "api head");

    const [first, second] = await Promise.all([scheduler.tick(), scheduler.tick()]);

    // Exactly one of the two concurrent ticks owns the branch — the lease decides,
    // not call ordering.
    expect(first.claimed + second.claimed).toBe(1);
    expect(trigger.calls).toHaveLength(1);
  });

  it("holds the cadence: a branch reviewed this window is not re-driven until the next one", async () => {
    const { scm, trigger, clock, scheduler } = build();
    scm.seedInstalledRepositories([{ repository: "acme/api", defaultBranch: "trunk" }]);
    scm.seedBranch("acme/api", "trunk", "a".repeat(40), "api head");

    await scheduler.tick();
    clock.advance(CADENCE_MS - 1);
    expect((await scheduler.tick()).claimed).toBe(0);

    // A new head in the next window is a new range to review.
    clock.advance(1);
    scm.seedBranch("acme/api", "trunk", "d".repeat(40), "moved on");
    const next = await scheduler.tick();
    expect(next.reviewed).toBe(1);
    expect(trigger.calls.at(-1)).toEqual({ repository: "acme/api", branch: "trunk", head: "d".repeat(40) });
  });

  it("reports a listing failure and schedules NOTHING — a provider fault is never a clean night", async () => {
    const { scm, schedule, trigger, scheduler } = build();
    scm.seedInstalledRepositories([{ repository: "acme/api", defaultBranch: "trunk" }]);
    scm.seedBranch("acme/api", "trunk", "a".repeat(40), "api head");
    scm.failInstallationListing("installation listing failed: 502 from GitHub");

    const failed = await scheduler.tick();
    expect(failed.listingError).toMatch(/502 from GitHub/);
    expect(failed.listed).toBe(0);
    expect(failed.claimed).toBe(0);
    expect(failed.outcomes).toEqual([]);
    expect(trigger.calls).toEqual([]);
    // Nothing was even stamped as attempted: the branch is still owed.
    expect(await schedule.get("acme/api", "trunk")).toBeNull();

    // The fault is one-shot, so the next tick recovers on its own.
    const recovered = await scheduler.tick();
    expect(recovered.listingError).toBeNull();
    expect(recovered.reviewed).toBe(1);
  });

  it("records a branch with no resolvable head as no-head rather than reviewed", async () => {
    const { scm, schedule, scheduler } = build();
    scm.seedInstalledRepositories([{ repository: "acme/empty", defaultBranch: "trunk" }]);
    // No seeded branch: an empty or deleted default branch resolves to null.
    const tick = await scheduler.tick();

    expect(tick.reviewed).toBe(0);
    expect(tick.outcomes[0]).toMatchObject({ status: "no-head", head: null });
    expect(await schedule.get("acme/empty", "trunk")).toMatchObject({ lastOutcome: "no-head", lastScheduledHead: null });
  });

  it("leaves a failed repository owed and keeps scheduling the others", async () => {
    const { scm, schedule, trigger, clock, scheduler } = build();
    scm.seedInstalledRepositories([
      { repository: "acme/api", defaultBranch: "trunk" },
      { repository: "acme/web", defaultBranch: "develop" },
    ]);
    scm.seedBranch("acme/api", "trunk", "a".repeat(40), "api head");
    scm.seedBranch("acme/web", "develop", "b".repeat(40), "web head");
    trigger.failOnce("acme/api", "analyzer exploded");

    const tick = await scheduler.tick();
    expect(tick.outcomes[0]).toMatchObject({ repository: "acme/api", status: "failed", detail: "analyzer exploded" });
    // One repository's failure does not stop the tick.
    expect(tick.outcomes[1]).toMatchObject({ repository: "acme/web", status: "reviewed" });
    const owed = await schedule.get("acme/api", "trunk");
    expect(owed).toMatchObject({ lastOutcome: "failed", lastError: "analyzer exploded", leaseId: null });

    // The failed branch is retried by a later window, not on every tick — a
    // released failure is finished work, not an outstanding attempt.
    expect((await scheduler.tick()).claimed).toBe(0);
    clock.advance(CADENCE_MS);
    const retry = await scheduler.tick();
    expect(retry.outcomes.find((o) => o.repository === "acme/api")).toMatchObject({ status: "reviewed" });
    // `acme/web` already reviewed this head to a complete watermark, so its retry is
    // `up-to-date` rather than a second report of the same range.
    expect(retry.outcomes.find((o) => o.repository === "acme/web")).toMatchObject({ status: "up-to-date" });
    expect(retry.reviewed).toBe(1);
  });

  it("defers past the batch size and says so, instead of implying full coverage", async () => {
    const { scm, trigger, logs, scheduler } = build({ batchSize: 1 });
    scm.seedInstalledRepositories([
      { repository: "acme/api", defaultBranch: "trunk" },
      { repository: "acme/web", defaultBranch: "develop" },
    ]);
    scm.seedBranch("acme/api", "trunk", "a".repeat(40), "api head");
    scm.seedBranch("acme/web", "develop", "b".repeat(40), "web head");

    const tick = await scheduler.tick();
    expect(tick.claimed).toBe(1);
    expect(trigger.calls).toHaveLength(1);
    expect(tick.outcomes.find((o) => o.repository === "acme/web")).toMatchObject({ status: "deferred" });
    expect(logs.join("\n")).toMatch(/batch limit 1 reached, 1 repositor/);

    // The deferred repository is picked up by the next tick — the lease/cadence gate
    // is per branch, so a repository that never ran is due immediately.
    const next = await scheduler.tick();
    expect(next.outcomes.find((o) => o.repository === "acme/web")).toMatchObject({ status: "reviewed" });
  });

  it("re-reads the installation every tick, so enrollment changes take effect", async () => {
    const { scm, trigger, clock, scheduler } = build();
    scm.seedInstalledRepositories([{ repository: "acme/api", defaultBranch: "trunk" }]);
    scm.seedBranch("acme/api", "trunk", "a".repeat(40), "api head");
    await scheduler.tick();

    // Uninstalled between nights: its schedule row is inert and it is not reviewed
    // again, even though the row (and the branch) still exist.
    scm.seedInstalledRepositories([{ repository: "acme/web", defaultBranch: "develop" }]);
    scm.seedBranch("acme/web", "develop", "b".repeat(40), "web head");
    clock.advance(CADENCE_MS);
    const tick = await scheduler.tick();

    expect(scm.installationListingCount()).toBe(2);
    expect(tick.outcomes.map((o) => o.repository)).toEqual(["acme/web"]);
    expect(trigger.calls.filter((c) => c.repository === "acme/api")).toHaveLength(1);
  });
});
