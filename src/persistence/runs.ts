import type { Clock, IdGenerator } from "../platform/clock.js";
import type { EvaluationRun, GateKind, RunState } from "../domain/evaluation/types.js";
import type { Finding, SubjectRevision } from "../domain/evidence/types.js";
import type { PoisonDecision } from "../gates/poison/decision.js";
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
  policy_version: string;
  state: RunState;
  attempt: number;
  created_at: Date;
  updated_at: Date;
}

function toRun(row: RunRow): EvaluationRun {
  return {
    id: row.id,
    kind: row.kind,
    subject: { repository: row.repository, commitSha: row.commit_sha },
    mergeGroupSha: row.merge_group_sha,
    policyVersion: row.policy_version,
    state: row.state,
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
   * and take a time-bounded lease in one atomic step. If another worker already
   * claimed it (state no longer pending), returns false.
   */
  async claimForAnalysis(runId: string, owner: string, leaseMs: number): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const now = this.clock.now();
      const expires = new Date(now.getTime() + leaseMs);
      const updated = await client.query(
        `update evaluation_runs
           set state = 'analyzing', updated_at = $2, attempt = attempt + 1,
               lease_owner = $3, lease_expires_at = $4
         where id = $1 and state = 'pending'`,
        [runId, now, owner, expires],
      );
      if ((updated.rowCount ?? 0) === 0) return false;
      await client.query(
        `insert into run_transitions (run_id, from_state, to_state, reason, at) values ($1, 'pending', 'analyzing', $2, $3)`,
        [runId, `claimed by ${owner}`, now],
      );
      return true;
    });
  }

  /**
   * Reclaim a crashed run: analyzing -> pending, but only if the lease has
   * expired (guard prevents stealing a live lease). Clears the lease so it can
   * be re-claimed. Returns false if the run is not analyzing or the lease is
   * still valid.
   */
  async reclaimExpired(runId: string): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const now = this.clock.now();
      const updated = await client.query(
        `update evaluation_runs
           set state = 'pending', updated_at = $2, lease_owner = null, lease_expires_at = null
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
  }): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const applied = await this.#transitionOn(client, params.runId, params.from, params.to, params.reason);
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

  async #transitionOn(
    client: PoolClient,
    runId: string,
    from: RunState,
    to: RunState,
    reason: string,
  ): Promise<boolean> {
    const now = this.clock.now();
    const updated = await client.query(
      `update evaluation_runs
         set state = $2, updated_at = $3, lease_owner = null, lease_expires_at = null
       where id = $1 and state = $4`,
      [runId, to, now, from],
    );
    if ((updated.rowCount ?? 0) === 0) return false;

    await client.query(
      `insert into run_transitions (run_id, from_state, to_state, reason, at) values ($1, $2, $3, $4, $5)`,
      [runId, from, to, reason, now],
    );
    return true;
  }
}
