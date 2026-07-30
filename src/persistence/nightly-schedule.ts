import type { Pool } from "./db.js";

/**
 * Durable state for the hosted nightly SCHEDULE.
 *
 * Two questions, one row per (repository, branch):
 *
 *  - is this branch DUE? (`last_started_at` older than the cadence window)
 *  - may I drive it? (nobody else holds an unexpired lease)
 *
 * Both are answered by ONE atomic statement in `claim`, because answering them
 * separately is exactly how two timer ticks both decide they are allowed to run.
 * The claim also stamps `last_started_at`, so a branch whose attempt throws waits
 * for its next window instead of being retried on every tick.
 *
 * This store schedules; it does not enroll. It never decides WHICH repositories
 * exist — that comes from the App installation on every tick — and it never
 * decides which range to review, which comes from the complete-review watermark.
 * A row for a repository that has since been uninstalled is inert.
 */

/** A granted attempt: the caller owns (repository, branch) until the lease expires. */
export interface NightlyScheduleClaim {
  repository: string;
  branch: string;
  /** Fencing id; `release` only clears a lease it still owns. */
  leaseId: string;
}

export interface ClaimScheduleInput {
  repository: string;
  branch: string;
  /** Recorded lease owner (process/worker identity). */
  owner: string;
  now: Date;
  /** How long the claim is held before another worker may take it over. */
  leaseMs: number;
  /**
   * Cadence gate: only claim when the last attempt STARTED at or before this
   * instant (typically `now - cadenceMs`). A branch never scheduled before has no
   * start on record and is always due.
   *
   * An OUTSTANDING attempt (claimed, never released — i.e. a crash) bypasses this
   * gate once its lease has expired: see `NightlyScheduleStore.claim`.
   */
  dueBefore: Date;
}

export interface ReleaseScheduleInput {
  repository: string;
  branch: string;
  leaseId: string;
  now: Date;
  /** The immutable head the attempt was scheduled at, or null when none resolved. */
  head: string | null;
  outcome: string;
  /** Provider/analysis failure detail, or null. */
  error: string | null;
}

/** Read model for operators (`app-doctor`, tests) — never used to derive a range. */
export interface NightlyScheduleState {
  repository: string;
  branch: string;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastScheduledHead: string | null;
  lastOutcome: string | null;
  lastError: string | null;
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
}

export interface NightlySchedulePort {
  /**
   * Take the attempt lease for one branch, or return null when it is not due yet
   * or somebody else owns it. Atomic: concurrent callers cannot both win.
   */
  claim(input: ClaimScheduleInput): Promise<NightlyScheduleClaim | null>;
  /**
   * Release a lease we still hold and record how the attempt ended. A lease that
   * expired and was taken over by another worker is NOT clobbered.
   */
  release(input: ReleaseScheduleInput): Promise<boolean>;
  /** Current state for one branch, or null when it has never been scheduled. */
  get(repository: string, branch: string): Promise<NightlyScheduleState | null>;
}

interface ScheduleRow {
  repository: string;
  branch: string;
  last_started_at: Date | null;
  last_finished_at: Date | null;
  last_scheduled_head: string | null;
  last_outcome: string | null;
  last_error: string | null;
  attempts: string | number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
}

export class NightlyScheduleStore implements NightlySchedulePort {
  /**
   * No clock: every instant this store writes is supplied by the CALLER (the
   * scheduler's own clock), so a fake clock in a test moves the cadence window
   * exactly as it moves the scheduler.
   */
  constructor(private readonly pool: Pool) {}

  /**
   * One statement. The `on conflict ... do update ... where` predicate is the whole
   * mechanism: the update (and therefore the `returning`) only happens when the row
   * is unleased-or-expired AND owed, so a losing caller gets no row rather than a
   * second lease. `attempts` is bumped on every grant so a repeatedly failing branch
   * is visible to an operator.
   *
   * "Owed" is two things, and conflating them is a bug we already made once:
   *
   *  - DUE BY CADENCE — the last attempt started before the cadence window. This is
   *    the normal nightly rhythm.
   *  - OUTSTANDING — an attempt was claimed and never released, which only happens
   *    when the process died mid-run (`last_finished_at` is null or older than
   *    `last_started_at`). Such a branch is owed as soon as its LEASE expires, not a
   *    whole cadence later; otherwise a crash at 02:00 silently costs a full night
   *    and the lease duration would do nothing at all.
   *
   * A FAILED attempt is released (finished), so it waits for its next window rather
   * than being retried on every tick.
   */
  async claim(input: ClaimScheduleInput): Promise<NightlyScheduleClaim | null> {
    const leaseId = `${input.owner}:${input.now.toISOString()}`;
    const expires = new Date(input.now.getTime() + input.leaseMs);
    const result = await this.pool.query<{ lease_id: string }>(
      `insert into nightly_schedule_state
         (repository, branch, lease_owner, lease_id, lease_expires_at, last_started_at, attempts, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, 1, $6, $6)
       on conflict (repository, branch) do update
         set lease_owner      = excluded.lease_owner,
             lease_id         = excluded.lease_id,
             lease_expires_at = excluded.lease_expires_at,
             last_started_at  = excluded.last_started_at,
             attempts         = nightly_schedule_state.attempts + 1,
             updated_at       = excluded.updated_at
         where (nightly_schedule_state.lease_expires_at is null or nightly_schedule_state.lease_expires_at <= $6)
           and (nightly_schedule_state.last_started_at is null
                or nightly_schedule_state.last_started_at <= $7
                or nightly_schedule_state.last_finished_at is null
                or nightly_schedule_state.last_finished_at < nightly_schedule_state.last_started_at)
       returning lease_id`,
      [input.repository, input.branch, input.owner, leaseId, expires, input.now, input.dueBefore],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { repository: input.repository, branch: input.branch, leaseId: row.lease_id };
  }

  async release(input: ReleaseScheduleInput): Promise<boolean> {
    const result = await this.pool.query(
      `update nightly_schedule_state
          set lease_owner         = null,
              lease_id            = null,
              lease_expires_at    = null,
              last_finished_at    = $4,
              last_scheduled_head = $5,
              last_outcome        = $6,
              last_error          = $7,
              updated_at          = $4
        where repository = $1 and branch = $2 and lease_id = $3`,
      [input.repository, input.branch, input.leaseId, input.now, input.head, input.outcome, input.error],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async get(repository: string, branch: string): Promise<NightlyScheduleState | null> {
    const result = await this.pool.query<ScheduleRow>(
      `select repository, branch, last_started_at, last_finished_at, last_scheduled_head,
              last_outcome, last_error, attempts, lease_owner, lease_expires_at
         from nightly_schedule_state
        where repository = $1 and branch = $2`,
      [repository, branch],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      repository: row.repository,
      branch: row.branch,
      lastStartedAt: row.last_started_at,
      lastFinishedAt: row.last_finished_at,
      lastScheduledHead: row.last_scheduled_head,
      lastOutcome: row.last_outcome,
      lastError: row.last_error,
      attempts: Number(row.attempts),
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at,
    };
  }
}
