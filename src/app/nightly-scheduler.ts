import type { Clock } from "../platform/clock.js";
import type { NightlySchedulePort } from "../persistence/nightly-schedule.js";
import type { InstalledRepository, ScmInstallationReader } from "../providers/scm/port.js";

/**
 * The hosted nightly TRIGGER.
 *
 * Enrollment is the GitHub App installation, so every tick asks the provider which
 * repositories it can see and schedules exactly those, at each one's RESOLVED
 * default branch head. Three things this deliberately never does:
 *
 *  - it never assumes `main`. The default branch is whatever GitHub says it is, per
 *    repository, read fresh every tick (a repository can be renamed or switch
 *    default branch between nights);
 *  - it never takes a head from repository-controlled input. The head sha is
 *    resolved through the read credential and is immutable for the range it drives;
 *  - it never turns a provider failure into a clean run. A listing that throws
 *    schedules NOTHING and is reported; a per-repository failure is recorded on that
 *    repository's schedule row and leaves the branch owed.
 *
 * Range selection is not this module's business: `runNightly` starts at the last
 * COMPLETE watermark, so a night whose coverage was incomplete is re-reviewed from
 * the same base by a later tick rather than being stepped over.
 *
 * OVERLAP AND RESTART SAFETY. Every attempt takes a durable per-branch lease that
 * also carries the cadence stamp (see `persistence/nightly-schedule.ts`), so:
 * overlapping timer ticks in one process, a second replica, and a process that
 * crashed mid-run all converge on "at most one attempt per branch per cadence
 * window, resumable once the lease expires". Nothing external is duplicated by a
 * re-drive: the run, its report identity, its issue graph, and its fix proposals are
 * all keyed on the immutable (base, head] identity.
 */

/** What the scheduler needs from the nightly gate — `Scruffy` satisfies it. */
export interface NightlyReviewTrigger {
  runNightly(input: { repository: string; branch: string; head: string }): Promise<{ reviewed: boolean }>;
}

export type NightlyScheduleStatus =
  /** A review ran for this branch (a report was committed, clean or not). */
  | "reviewed"
  /** Nothing new since the last COMPLETE review. */
  | "up-to-date"
  /** The provider returned no head for the default branch (empty/unreadable). */
  | "no-head"
  /** Archived or disabled in the installation — not reviewable work. */
  | "skipped"
  /** Not due yet, or another worker holds the lease. */
  | "deferred"
  /** The attempt failed. The branch stays owed and is retried next window. */
  | "failed";

export interface NightlyScheduleOutcome {
  repository: string;
  branch: string;
  /** The immutable head the attempt was scheduled at, when one was resolved. */
  head: string | null;
  status: NightlyScheduleStatus;
  detail: string | null;
}

export interface NightlyTickResult {
  /** Repositories the installation reported. */
  listed: number;
  /** Of those, the ones that are reviewable (not archived/disabled). */
  eligible: number;
  claimed: number;
  reviewed: number;
  outcomes: NightlyScheduleOutcome[];
  /**
   * Non-null when the installation listing itself failed. NOTHING was scheduled in
   * that case — the tick is a reported failure, never an empty success.
   */
  listingError: string | null;
}

export interface NightlySchedulerDeps {
  installations: ScmInstallationReader;
  schedule: NightlySchedulePort;
  trigger: NightlyReviewTrigger;
  clock: Clock;
  /** Minimum interval between two scheduled attempts for one branch. */
  cadenceMs: number;
  /** How long one attempt may hold its branch before another worker takes over. */
  leaseMs: number;
  /** Recorded lease owner. Distinct per process in a multi-replica deployment. */
  owner: string;
  /** Maximum repositories driven in ONE tick. The rest wait for the next tick. */
  batchSize?: number;
  log?: (message: string) => void;
}

const DEFAULT_BATCH_SIZE = 20;

export class NightlyScheduler {
  readonly #batchSize: number;
  readonly #log: (message: string) => void;

  constructor(private readonly deps: NightlySchedulerDeps) {
    this.#batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#log = deps.log ?? ((message) => console.error(message));
  }

  /**
   * One pass over the installation. Safe to call concurrently with itself, with the
   * reconcile loop, and with the manual `scruffy:nightly` command.
   */
  async tick(): Promise<NightlyTickResult> {
    const result: NightlyTickResult = {
      listed: 0,
      eligible: 0,
      claimed: 0,
      reviewed: 0,
      outcomes: [],
      listingError: null,
    };

    let repositories: InstalledRepository[];
    try {
      repositories = await this.deps.installations.listInstalledRepositories();
    } catch (err) {
      // A partial or failed listing must not schedule a subset and call the tick
      // done: the repositories we could not see would look reviewed-up-to-date by
      // omission on the next operator glance. Report and schedule nothing.
      result.listingError = err instanceof Error ? err.message : String(err);
      this.#log(`nightly schedule: installation listing failed, scheduling nothing this tick: ${result.listingError}`);
      return result;
    }

    result.listed = repositories.length;
    const eligible: InstalledRepository[] = [];
    for (const repository of repositories) {
      if (repository.archived || repository.disabled) {
        result.outcomes.push({
          repository: repository.repository,
          branch: repository.defaultBranch,
          head: null,
          status: "skipped",
          detail: repository.archived ? "archived in the installation" : "disabled in the installation",
        });
        continue;
      }
      eligible.push(repository);
    }
    result.eligible = eligible.length;

    for (const repository of eligible) {
      if (result.claimed >= this.#batchSize) {
        // A bounded tick is a coverage claim we must not hide: an operator reading
        // "12 scheduled" needs to know the rest were left for the next tick rather
        // than assuming the installation was fully covered.
        this.#log(
          `nightly schedule: batch limit ${this.#batchSize} reached, ${eligible.length - result.claimed} repositor(ies) deferred to the next tick`,
        );
        result.outcomes.push({
          repository: repository.repository,
          branch: repository.defaultBranch,
          head: null,
          status: "deferred",
          detail: `batch limit ${this.#batchSize} reached this tick`,
        });
        continue;
      }
      result.outcomes.push(await this.#scheduleOne(repository, result));
    }
    return result;
  }

  async #scheduleOne(repository: InstalledRepository, result: NightlyTickResult): Promise<NightlyScheduleOutcome> {
    const branch = repository.defaultBranch;
    const now = this.deps.clock.now();
    const claim = await this.deps.schedule.claim({
      repository: repository.repository,
      branch,
      owner: this.deps.owner,
      now,
      leaseMs: this.deps.leaseMs,
      dueBefore: new Date(now.getTime() - this.deps.cadenceMs),
    });
    if (claim === null) {
      return {
        repository: repository.repository,
        branch,
        head: null,
        status: "deferred",
        detail: "not due yet, or another worker holds the schedule lease",
      };
    }
    result.claimed += 1;

    let head: string | null = null;
    let status: NightlyScheduleStatus = "failed";
    let detail: string | null = null;
    try {
      // The head is resolved through the read credential, never supplied by the
      // repository, and it is fixed for the whole attempt: the range is immutable
      // even if the branch moves while we analyze it.
      head = await this.deps.installations.resolveBranchHead(repository.repository, branch);
      if (head === null) {
        status = "no-head";
        detail = `no head resolved for default branch '${branch}'`;
      } else {
        const review = await this.deps.trigger.runNightly({ repository: repository.repository, branch, head });
        status = review.reviewed ? "reviewed" : "up-to-date";
        if (review.reviewed) result.reviewed += 1;
      }
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
      this.#log(`nightly schedule: ${repository.repository}@${branch} failed (retried next window): ${detail}`);
    } finally {
      await this.deps.schedule.release({
        repository: repository.repository,
        branch,
        leaseId: claim.leaseId,
        now: this.deps.clock.now(),
        head,
        outcome: status,
        error: detail,
      });
    }
    return { repository: repository.repository, branch, head, status, detail };
  }
}
