import type { Clock, IdGenerator } from "../platform/clock.js";
import type { EvaluationRun, GateKind, RunState } from "../domain/evaluation/types.js";
import type { Finding, SubjectRevision } from "../domain/evidence/types.js";
import type { PoisonDecision } from "../gates/poison/decision.js";
import type { NightlyDecision } from "../gates/nightly/decision.js";
import type { ReleaseDecision } from "../gates/release/decision.js";
import { withTransaction, type Pool, type PoolClient } from "./db.js";

/**
 * Durable store for evaluation runs, their transitions, decisions, and outbox
 * effects. The load-bearing method is `commitDecision`: it writes the terminal
 * transition, the decision, and the outbox effect in ONE transaction, so an
 * external effect can never be recorded without its state change (or vice
 * versa). This is ADR 0003 validation #3.
 *
 * State transitions are guarded (`where state = expected`) so duplicate webhook
 * delivery or a second worker cannot double-apply: the second update touches 0
 * rows and is reported as not-applied. This is ADR 0003 validation #4.
 */

interface RunRow {
  id: string;
  kind: GateKind;
  repository: string;
  commit_sha: string;
  merge_group_sha: string | null;
  base_sha: string | null;
  branch: string | null;
  policy_version: string;
  state: RunState;
  attempt: number;
  lease_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function toRun(row: RunRow): EvaluationRun {
  return {
    id: row.id,
    kind: row.kind,
    subject: { repository: row.repository, commitSha: row.commit_sha },
    mergeGroupSha: row.merge_group_sha,
    baseSha: row.base_sha,
    branch: row.branch,
    policyVersion: row.policy_version,
    state: row.state,
    attempt: row.attempt,
    leaseId: row.lease_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The durable review watermark for a (repository, branch). */
export interface ReviewWatermark {
  repository: string;
  branch: string;
  lastReviewedHead: string;
}

export interface OutboxEffect {
  effectType: string;
  externalId: string;
  payload: unknown;
}

export class RunStore {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * Idempotent: returns the existing run for (repository, commitSha, kind) or
   * creates a fresh `pending` one. A webhook is a prompt to reconcile — it must
   * not create a duplicate run on re-delivery.
   */
  async ensureRun(subject: SubjectRevision, kind: GateKind, policyVersion: string): Promise<EvaluationRun> {
    const now = this.clock.now();
    const id = this.ids.next("run");
    const result = await this.pool.query<RunRow>(
      `insert into evaluation_runs
         (id, kind, repository, commit_sha, merge_group_sha, policy_version, state, attempt, created_at, updated_at)
       values ($1, $2, $3, $4, null, $5, 'pending', 0, $6, $6)
       on conflict (repository, commit_sha, kind) do update
         set updated_at = evaluation_runs.updated_at
       returning *`,
      [id, kind, subject.repository, subject.commitSha, policyVersion, now],
    );
    return toRun(result.rows[0]!);
  }

  /**
   * Idempotent nightly run for the range (baseSha, head] on a branch. Identity is
   * still (repository, head, kind); base and branch are frozen onto the run so a
   * crashed run reconciles against the same range even after the watermark moves.
   */
  async ensureNightlyRun(
    head: SubjectRevision,
    branch: string,
    baseSha: string | null,
    policyVersion: string,
  ): Promise<EvaluationRun> {
    const now = this.clock.now();
    const id = this.ids.next("run");
    const result = await this.pool.query<RunRow>(
      `insert into evaluation_runs
         (id, kind, repository, commit_sha, merge_group_sha, base_sha, branch, policy_version, state, attempt, created_at, updated_at)
       values ($1, 'nightly', $2, $3, null, $4, $5, $6, 'pending', 0, $7, $7)
       on conflict (repository, commit_sha, kind) do update
         set updated_at = evaluation_runs.updated_at
       returning *`,
      [id, head.repository, head.commitSha, baseSha, branch, policyVersion, now],
    );
    return toRun(result.rows[0]!);
  }

  /**
   * Idempotent release run for the range (prevReleaseSha, candidate]. Identity is
   * (repository, candidate, kind='release'); the prev-release lower bound is frozen
   * onto the run via the gate-neutral base_sha so a crashed run reconciles against
   * the SAME range. branch stays null — release is not branch-scoped (no watermark).
   *
   * The range is frozen to the FIRST trigger: re-triggering the same candidate with
   * a different prevRelease is a no-op on base_sha (only updated_at is touched), and
   * the original range wins. This is deliberate — reconciliation must re-drive the
   * exact range the run was created for, not a range that moved underneath it.
   */
  async ensureReleaseRun(
    candidate: SubjectRevision,
    prevReleaseSha: string | null,
    policyVersion: string,
  ): Promise<EvaluationRun> {
    const now = this.clock.now();
    const id = this.ids.next("run");
    const result = await this.pool.query<RunRow>(
      `insert into evaluation_runs
         (id, kind, repository, commit_sha, merge_group_sha, base_sha, branch, policy_version, state, attempt, created_at, updated_at)
       values ($1, 'release', $2, $3, null, $4, null, $5, 'pending', 0, $6, $6)
       on conflict (repository, commit_sha, kind) do update
         set updated_at = evaluation_runs.updated_at
       returning *`,
      [id, candidate.repository, candidate.commitSha, prevReleaseSha, policyVersion, now],
    );
    return toRun(result.rows[0]!);
  }

  /** The current review watermark for a (repository, branch), or null if never reviewed. */
  async getWatermark(repository: string, branch: string): Promise<ReviewWatermark | null> {
    const result = await this.pool.query<{ repository: string; branch: string; last_reviewed_head: string }>(
      `select repository, branch, last_reviewed_head from review_watermarks where repository = $1 and branch = $2`,
      [repository, branch],
    );
    const row = result.rows[0];
    return row ? { repository: row.repository, branch: row.branch, lastReviewedHead: row.last_reviewed_head } : null;
  }

  async getRun(id: string): Promise<EvaluationRun | null> {
    const result = await this.pool.query<RunRow>("select * from evaluation_runs where id = $1", [id]);
    const row = result.rows[0];
    return row ? toRun(row) : null;
  }

  /**
   * Guarded transition with no side effects. Returns true if this call performed
   * the transition, false if the run was not in `from` (already moved /
   * superseded / concurrent worker). Clears any lease.
   */
  async transition(runId: string, from: RunState, to: RunState, reason: string): Promise<boolean> {
    return withTransaction(this.pool, (client) => this.#transitionOn(client, runId, from, to, reason));
  }

  /**
   * Claim a pending run for analysis: guarded pending -> analyzing, bump attempt,
   * and take a time-bounded lease in one atomic step. Mints a fresh fencing token
   * and returns it on success; returns null if another worker already claimed it
   * (state no longer pending). The caller must pass the returned token back to the
   * matching commit* so a stale worker cannot land a decision over a newer claim.
   */
  async claimForAnalysis(runId: string, owner: string, leaseMs: number): Promise<string | null> {
    return withTransaction(this.pool, async (client) => {
      const now = this.clock.now();
      const expires = new Date(now.getTime() + leaseMs);
      const leaseId = this.ids.next("lease");
      const updated = await client.query(
        `update evaluation_runs
           set state = 'analyzing', updated_at = $2, attempt = attempt + 1,
               lease_owner = $3, lease_expires_at = $4, lease_id = $5
         where id = $1 and state = 'pending'`,
        [runId, now, owner, expires, leaseId],
      );
      if ((updated.rowCount ?? 0) === 0) return null;
      await client.query(
        `insert into run_transitions (run_id, from_state, to_state, reason, at) values ($1, 'pending', 'analyzing', $2, $3)`,
        [runId, `claimed by ${owner}`, now],
      );
      return leaseId;
    });
  }

  /**
   * Reclaim a crashed run: analyzing -> pending, but only if the lease has
   * expired (guard prevents stealing a live lease). Clears the lease (owner,
   * expiry, and fencing token) so it can be re-claimed and the crashed worker's
   * token no longer matches. Returns false if the run is not analyzing or the
   * lease is still valid.
   */
  async reclaimExpired(runId: string): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const now = this.clock.now();
      const updated = await client.query(
        `update evaluation_runs
           set state = 'pending', updated_at = $2, lease_owner = null, lease_expires_at = null, lease_id = null
         where id = $1 and state = 'analyzing' and lease_expires_at < $2`,
        [runId, now],
      );
      if ((updated.rowCount ?? 0) === 0) return false;
      await client.query(
        `insert into run_transitions (run_id, from_state, to_state, reason, at) values ($1, 'analyzing', 'pending', 'lease expired: reclaimed', $2)`,
        [runId, now],
      );
      return true;
    });
  }

  /**
   * Runs that need reconciliation independent of webhook delivery: stuck
   * `pending` runs, and `analyzing` runs whose lease has expired (crashed
   * mid-analysis).
   */
  async findReconcilable(limit: number): Promise<EvaluationRun[]> {
    const now = this.clock.now();
    const result = await this.pool.query<RunRow>(
      `select * from evaluation_runs
         where state = 'pending'
            or (state = 'analyzing' and lease_expires_at < $1)
         order by updated_at
         limit $2`,
      [now, limit],
    );
    return result.rows.map(toRun);
  }

  /**
   * Atomically: move analyzing -> terminal, record the poison decision and its
   * findings, and enqueue the outbox effect. All-or-nothing.
   */
  async commitDecision(params: {
    runId: string;
    from: RunState;
    to: RunState;
    reason: string;
    decision: PoisonDecision;
    findings: Finding[];
    effect: OutboxEffect;
    /** Fencing token from the claim; the commit only lands if the lease still matches. */
    fenceLease?: string;
  }): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const applied = await this.#transitionOn(client, params.runId, params.from, params.to, params.reason, params.fenceLease);
      if (!applied) return false;

      const now = this.clock.now();
      await client.query(
        `insert into poison_decisions (run_id, outcome, reasons, dispositions, findings, decided_at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (run_id) do nothing`,
        [
          params.runId,
          params.decision.outcome,
          JSON.stringify(params.decision.reasons),
          JSON.stringify(params.decision.dispositions),
          JSON.stringify(params.findings),
          now,
        ],
      );
      await client.query(
        `insert into outbox (id, run_id, effect_type, external_id, payload, status, attempts, created_at)
         values ($1, $2, $3, $4, $5, 'pending', 0, $6)
         on conflict (run_id, external_id) do nothing`,
        [
          this.ids.next("obx"),
          params.runId,
          params.effect.effectType,
          params.effect.externalId,
          JSON.stringify(params.effect.payload),
          now,
        ],
      );
      return true;
    });
  }

  /**
   * Atomically, for a nightly run: move analyzing -> terminal, record the
   * decision and its findings, enqueue the outbox effect, and — only when the run
   * actually `decided` — advance the review watermark.
   *
   * The watermark advance is GUARDED on the base we reviewed
   * (`last_reviewed_head is not distinct from base`, null-safe for a first review):
   *  - it advances only if the watermark still points at our base, so it never
   *    regresses and an out-of-order/older head cannot clobber a newer watermark;
   *  - a stale advance simply touches 0 rows — the decision + effect still commit.
   * The decision does NOT advance the watermark on `indeterminate`: a range we
   * could not review must be re-reviewed later, so the watermark stays put.
   */
  async commitNightlyDecision(params: {
    runId: string;
    from: RunState;
    to: RunState;
    reason: string;
    repository: string;
    branch: string;
    baseSha: string | null;
    headSha: string;
    decision: NightlyDecision;
    findings: Finding[];
    /** Summary check plus any fix-PR effects; enqueued in the same transaction. */
    effects: OutboxEffect[];
    /** Fencing token from the claim; the commit only lands if the lease still matches. */
    fenceLease?: string;
  }): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const applied = await this.#transitionOn(client, params.runId, params.from, params.to, params.reason, params.fenceLease);
      if (!applied) return false;

      const now = this.clock.now();
      await client.query(
        `insert into nightly_decisions (run_id, dispositions, findings, summary, decided_at)
         values ($1, $2, $3, $4, $5)
         on conflict (run_id) do nothing`,
        [
          params.runId,
          JSON.stringify(params.decision.dispositions),
          JSON.stringify(params.findings),
          JSON.stringify(params.decision.summary),
          now,
        ],
      );
      for (const effect of params.effects) {
        await client.query(
          `insert into outbox (id, run_id, effect_type, external_id, payload, status, attempts, created_at)
           values ($1, $2, $3, $4, $5, 'pending', 0, $6)
           on conflict (run_id, external_id) do nothing`,
          [this.ids.next("obx"), params.runId, effect.effectType, effect.externalId, JSON.stringify(effect.payload), now],
        );
      }

      if (params.to === "decided") {
        await client.query(
          `insert into review_watermarks (repository, branch, last_reviewed_head, updated_at)
           values ($1, $2, $3, $4)
           on conflict (repository, branch) do update
             set last_reviewed_head = excluded.last_reviewed_head, updated_at = excluded.updated_at
             where review_watermarks.last_reviewed_head is not distinct from $5`,
          [params.repository, params.branch, params.headSha, now, params.baseSha],
        );
      }
      return true;
    });
  }

  /**
   * Atomically, for a release run: move analyzing -> terminal, record the
   * decision and its findings, and enqueue the outbox effect. All-or-nothing —
   * an external effect can never be recorded without its state change. Mirrors
   * commitDecision (poison): one aggregate outcome, one advisory check effect.
   * Release owns no watermark (it is triggered per candidate), so there is
   * nothing to advance here.
   */
  async commitReleaseDecision(params: {
    runId: string;
    from: RunState;
    to: RunState;
    reason: string;
    decision: ReleaseDecision;
    findings: Finding[];
    effect: OutboxEffect;
    /** Fencing token from the claim; the commit only lands if the lease still matches. */
    fenceLease?: string;
  }): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const applied = await this.#transitionOn(client, params.runId, params.from, params.to, params.reason, params.fenceLease);
      if (!applied) return false;

      const now = this.clock.now();
      await client.query(
        `insert into release_decisions (run_id, outcome, reasons, dispositions, findings, summary, decided_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (run_id) do nothing`,
        [
          params.runId,
          params.decision.outcome,
          JSON.stringify(params.decision.reasons),
          JSON.stringify(params.decision.dispositions),
          JSON.stringify(params.findings),
          JSON.stringify(params.decision.summary),
          now,
        ],
      );
      await client.query(
        `insert into outbox (id, run_id, effect_type, external_id, payload, status, attempts, created_at)
         values ($1, $2, $3, $4, $5, 'pending', 0, $6)
         on conflict (run_id, external_id) do nothing`,
        [
          this.ids.next("obx"),
          params.runId,
          params.effect.effectType,
          params.effect.externalId,
          JSON.stringify(params.effect.payload),
          now,
        ],
      );
      return true;
    });
  }

  /**
   * Guarded state transition. When `fenceLease` is provided the update also
   * requires the run's current `lease_id` to match it, so only the worker that
   * still holds the live lease can commit — a reclaimed/superseded worker's
   * commit touches 0 rows and is reported as not-applied. Clears the lease.
   */
  async #transitionOn(
    client: PoolClient,
    runId: string,
    from: RunState,
    to: RunState,
    reason: string,
    fenceLease?: string,
  ): Promise<boolean> {
    const now = this.clock.now();
    const params: unknown[] = [runId, to, now, from];
    let guard = "where id = $1 and state = $4";
    if (fenceLease !== undefined) {
      params.push(fenceLease);
      guard += ` and lease_id = $${params.length}`;
    }
    const updated = await client.query(
      `update evaluation_runs
         set state = $2, updated_at = $3, lease_owner = null, lease_expires_at = null, lease_id = null
       ${guard}`,
      params,
    );
    if ((updated.rowCount ?? 0) === 0) return false;

    await client.query(
      `insert into run_transitions (run_id, from_state, to_state, reason, at) values ($1, $2, $3, $4, $5)`,
      [runId, from, to, reason, now],
    );
    return true;
  }
}
