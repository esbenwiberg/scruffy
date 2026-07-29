import type { Clock, IdGenerator } from "../platform/clock.js";
import type { EvaluationRun, GateKind, RunState } from "../domain/evaluation/types.js";
import type { Finding, SubjectRevision } from "../domain/evidence/types.js";
import type { PoisonDecision } from "../gates/poison/decision.js";
import type { NightlyDecision } from "../gates/nightly/decision.js";
import type { ReleaseDecision } from "../gates/release/decision.js";
import { findingKey } from "../domain/findings/identity.js";
import {
  isCompleteReview,
  type NightlyReport,
  type NightlyWorkGraph,
  type NightlyWorkItem,
  type ProposalCiState,
  type ProposalDelivery,
  type ProposalMergeState,
} from "../domain/findings/work-graph.js";
import type { EffectDependency, EffectProduction } from "../domain/findings/work-publication.js";
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

/**
 * The durable COMPLETE-review watermark for a (repository, branch): the last head
 * whose range was reviewed with no required coverage gap. Absent (null) when the
 * branch has never been completely reviewed, even if terminal attempts exist.
 */
export interface ReviewWatermark {
  repository: string;
  branch: string;
  lastReviewedHead: string;
}

/** Both heads on record for a branch. `lastAttemptedHead` is audit only. */
export interface ReviewProgress {
  repository: string;
  branch: string;
  /** Last COMPLETELY reviewed head, or null if there has never been one. */
  lastCompleteHead: string | null;
  /** Last head a terminal attempt was committed for, or null. */
  lastAttemptedHead: string | null;
}

/** What a persisted nightly report says about its own completeness. */
export interface PersistedReportState {
  reportId: string;
  runId: string;
  headSha: string;
  baseSha: string | null;
  requiredCoverageComplete: boolean;
}

export interface OutboxEffect {
  effectType: string;
  externalId: string;
  payload: unknown;
  /**
   * The external reference this effect makes available to dependent effects, if
   * any. Recorded so a dead letter can be attributed to the right work item.
   */
  produces?: EffectProduction;
  /**
   * References this effect needs before it may be delivered. Persisted as explicit
   * dependency rows and enforced by the claim query — outbox insertion order is NOT
   * a correctness mechanism, because a retry, an expired claim, or a partly failed
   * batch reorders delivery freely.
   */
  dependsOn?: readonly EffectDependency[];
}

/**
 * Everything the nightly gate needs from durable storage. Extracted as a port so
 * the gate is testable against an in-memory double without a database, while
 * `RunStore` remains the single production implementation (ADR 0003 keeps
 * Postgres authoritative — this interface adds no second source of truth).
 */
export interface NightlyRunStore {
  getWatermark(repository: string, branch: string): Promise<ReviewWatermark | null>;
  ensureNightlyRun(
    head: SubjectRevision,
    branch: string,
    baseSha: string | null,
    policyVersion: string,
  ): Promise<EvaluationRun>;
  getRun(id: string): Promise<EvaluationRun | null>;
  transition(runId: string, from: RunState, to: RunState, reason: string): Promise<boolean>;
  claimForAnalysis(runId: string, owner: string, leaseMs: number): Promise<string | null>;
  renewLease(runId: string, leaseId: string, leaseMs: number): Promise<boolean>;
  latestNightlyReportForRun(runId: string): Promise<PersistedReportState | null>;
  commitNightlyDecision(params: CommitNightlyDecisionParams): Promise<boolean>;
}

export interface CommitNightlyDecisionParams {
  runId: string;
  from: RunState;
  to: RunState;
  reason: string;
  /** The durable report: identity, coverage, and the whole finding graph. */
  report: NightlyReport;
  /** The intended human-visible work. Parent null for a complete, clean run. */
  workGraph: NightlyWorkGraph;
  decision: NightlyDecision;
  findings: Finding[];
  /** Summary check plus any fix-PR effects; enqueued in the same transaction. */
  effects: OutboxEffect[];
  /** Fencing token from the claim; the commit only lands if the lease still matches. */
  fenceLease?: string;
}

export class RunStore implements NightlyRunStore {
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

  /**
   * The COMPLETE-review watermark for a (repository, branch), or null when the
   * branch has never been completely reviewed. A branch with attempts but no
   * complete review reads as null here on purpose: the next range must start from
   * the last head we actually finished reviewing, never from one we merely tried.
   */
  async getWatermark(repository: string, branch: string): Promise<ReviewWatermark | null> {
    const result = await this.pool.query<{ repository: string; branch: string; last_reviewed_head: string | null }>(
      `select repository, branch, last_reviewed_head from review_watermarks where repository = $1 and branch = $2`,
      [repository, branch],
    );
    const row = result.rows[0];
    if (!row || row.last_reviewed_head === null) return null;
    return { repository: row.repository, branch: row.branch, lastReviewedHead: row.last_reviewed_head };
  }

  /** Both the complete and the attempted head for a branch, for audit/ops views. */
  async getReviewProgress(repository: string, branch: string): Promise<ReviewProgress | null> {
    const result = await this.pool.query<{
      repository: string;
      branch: string;
      last_reviewed_head: string | null;
      last_attempted_head: string | null;
    }>(
      `select repository, branch, last_reviewed_head, last_attempted_head
         from review_watermarks where repository = $1 and branch = $2`,
      [repository, branch],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      repository: row.repository,
      branch: row.branch,
      lastCompleteHead: row.last_reviewed_head,
      lastAttemptedHead: row.last_attempted_head,
    };
  }

  /**
   * The most recent persisted report for a run. Used to decide whether a terminal
   * run may be retried: a run whose report did not completely review its range is
   * still owed a review, and a bounded successor attempt is legitimate.
   */
  async latestNightlyReportForRun(runId: string): Promise<PersistedReportState | null> {
    const result = await this.pool.query<{
      report_id: string;
      run_id: string;
      head_sha: string;
      base_sha: string | null;
      required_coverage_complete: boolean;
    }>(
      `select report_id, run_id, head_sha, base_sha, required_coverage_complete
         from nightly_reports where run_id = $1 order by created_at desc, report_id limit 1`,
      [runId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      reportId: row.report_id,
      runId: row.run_id,
      headSha: row.head_sha,
      baseSha: row.base_sha,
      requiredCoverageComplete: row.required_coverage_complete,
    };
  }

  /** The persisted work items for a report, parent first then children by id. */
  async getWorkItems(reportId: string): Promise<NightlyWorkItem[]> {
    const result = await this.pool.query<{
      work_item_id: string;
      report_id: string;
      kind: NightlyWorkItem["kind"];
      parent_work_item_id: string | null;
      occurrence_id: string | null;
      coverage_analyzer_id: string | null;
      coverage_gap_code: string | null;
      title: string;
      body: string;
      resolution: NightlyWorkItem["resolution"];
    }>(
      `select work_item_id, report_id, kind, parent_work_item_id, occurrence_id,
              coverage_analyzer_id, coverage_gap_code, title, body, resolution
         from nightly_work_items
        where report_id = $1
        order by (kind = 'nightly_run') desc, work_item_id`,
      [reportId],
    );
    return result.rows.map((row) => ({
      workItemId: row.work_item_id,
      reportId: row.report_id,
      kind: row.kind,
      parentWorkItemId: row.parent_work_item_id,
      occurrenceId: row.occurrence_id,
      coverageGap:
        row.coverage_analyzer_id !== null && row.coverage_gap_code !== null
          ? { analyzerId: row.coverage_analyzer_id, code: row.coverage_gap_code }
          : null,
      title: row.title,
      body: row.body,
      resolution: row.resolution,
    }));
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
   * Extend the lease on a run this worker still holds — the heartbeat behind a
   * slow-but-alive analysis. Guarded on BOTH `analyzing` and the fencing token,
   * so a worker that was already reclaimed/superseded cannot resurrect its lease.
   * Returns false when the lease is no longer ours (the caller should stop
   * heartbeating; its eventual commit will be fenced out anyway).
   */
  async renewLease(runId: string, leaseId: string, leaseMs: number): Promise<boolean> {
    const now = this.clock.now();
    const expires = new Date(now.getTime() + leaseMs);
    const updated = await this.pool.query(
      `update evaluation_runs
         set lease_expires_at = $3, updated_at = $2
       where id = $1 and state = 'analyzing' and lease_id = $4`,
      [runId, now, expires, leaseId],
    );
    return (updated.rowCount ?? 0) > 0;
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
   * decision, the durable report (coverage included), the deduplicated finding
   * graph, the intended work items and fix proposals, enqueue the outbox effects,
   * and — only when the run `decided` AND completely reviewed its range — advance
   * the complete-review watermark. All-or-nothing: there is no interleaving where
   * an external effect exists without the report it came from, and no interleaving
   * where the watermark claims a range whose report was not written.
   *
   * The complete advance is GUARDED on the base we reviewed
   * (`last_reviewed_head is not distinct from base`, null-safe for a first review):
   *  - it advances only if the watermark still points at our base, so it never
   *    regresses and an out-of-order/older head cannot clobber a newer watermark;
   *  - a stale advance simply touches 0 rows — the report + effects still commit.
   *
   * Two things deliberately do NOT advance it:
   *  - `indeterminate`: a range we could not review must be re-reviewed later;
   *  - a `decided` run with any REQUIRED coverage gap. This is the honesty fix the
   *    whole slice exists for — a watermark that steps over change no analyzer
   *    looked at is a claim no later run can ever detect as false.
   * The attempted head is recorded either way, so the attempt is auditable without
   * ever being mistaken for a review.
   *
   * Re-committing the SAME report identity is idempotent: reports/findings/work
   * items/proposals are keyed by their stable ids, so a retry after a crashed
   * publication updates the analysis facts in place and creates no duplicate work.
   * Human-owned lifecycle columns (`resolution`, proposal delivery/CI/merge state)
   * are never rewritten backwards by a re-commit.
   */
  async commitNightlyDecision(params: CommitNightlyDecisionParams): Promise<boolean> {
    const report = params.report;
    const identity = report.identity;
    return withTransaction(this.pool, async (client) => {
      const applied = await this.#transitionOn(client, params.runId, params.from, params.to, params.reason, params.fenceLease);
      if (!applied) return false;

      const now = this.clock.now();
      await client.query(
        `insert into nightly_decisions (run_id, dispositions, findings, summary, coverage, decided_at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (run_id) do update
           set dispositions = excluded.dispositions,
               findings     = excluded.findings,
               summary      = excluded.summary,
               coverage     = excluded.coverage,
               decided_at   = excluded.decided_at`,
        [
          params.runId,
          JSON.stringify(params.decision.dispositions),
          JSON.stringify(params.findings),
          JSON.stringify(params.decision.summary),
          JSON.stringify(params.decision.coverage),
          now,
        ],
      );

      await this.#writeReport(client, params, now);

      for (const effect of params.effects) {
        await this.#enqueueEffect(client, params.runId, effect, now);
      }

      // The attempt is always on record; only a COMPLETE review moves the watermark.
      await client.query(
        `insert into review_watermarks (repository, branch, last_reviewed_head, last_attempted_head, updated_at, attempted_at)
         values ($1, $2, null, $3, $4, $4)
         on conflict (repository, branch) do update
           set last_attempted_head = excluded.last_attempted_head,
               attempted_at        = excluded.attempted_at,
               updated_at          = excluded.updated_at`,
        [identity.repository, identity.branch, identity.headSha, now],
      );

      if (params.to === "decided" && isCompleteReview(report)) {
        await client.query(
          `update review_watermarks
              set last_reviewed_head = $3, updated_at = $4
            where repository = $1 and branch = $2
              and last_reviewed_head is not distinct from $5`,
          [identity.repository, identity.branch, identity.headSha, now, identity.baseSha],
        );
      }
      return true;
    });
  }

  /**
   * Enqueue one effect and its dependency edges, inside the caller's transaction.
   *
   * `on conflict do nothing` preserves the existing at-most-one-row-per
   * (run_id, external_id) behaviour for check/PR effects — a re-commit must not
   * resurrect an effect a dispatcher already sent or dead-lettered. Because that
   * returns no row on conflict, the existing id is read back explicitly: dependency
   * rows still have to attach to the row that IS there, or a redelivered commit
   * would leave a dependent effect with no declared dependencies and let it be
   * claimed before its references exist.
   */
  async #enqueueEffect(client: PoolClient, runId: string, effect: OutboxEffect, now: Date): Promise<void> {
    const inserted = await client.query<{ id: string }>(
      `insert into outbox
         (id, run_id, effect_type, external_id, payload, status, attempts, created_at,
          produces_work_item_id, produces)
       values ($1, $2, $3, $4, $5, 'pending', 0, $6, $7, $8)
       on conflict (run_id, external_id) do nothing
       returning id`,
      [
        this.ids.next("obx"),
        runId,
        effect.effectType,
        effect.externalId,
        JSON.stringify(effect.payload),
        now,
        effect.produces?.workItemId ?? null,
        effect.produces?.kind ?? null,
      ],
    );
    let outboxId = inserted.rows[0]?.id;
    if (outboxId === undefined) {
      const existing = await client.query<{ id: string }>(`select id from outbox where run_id = $1 and external_id = $2`, [
        runId,
        effect.externalId,
      ]);
      outboxId = existing.rows[0]?.id;
      if (outboxId === undefined) return; // Cannot happen; nothing sensible to attach to.
    }

    for (const dependency of effect.dependsOn ?? []) {
      await client.query(
        `insert into outbox_dependencies (outbox_id, requires_work_item_id, requires)
         values ($1, $2, $3)
         on conflict (outbox_id, requires_work_item_id, requires) do nothing`,
        [outboxId, dependency.workItemId, dependency.requires],
      );
    }
  }

  /** Report + finding graph + work items + proposals, inside the caller's transaction. */
  async #writeReport(client: PoolClient, params: CommitNightlyDecisionParams, now: Date): Promise<void> {
    const { report, workGraph } = params;
    const identity = report.identity;
    const findingsByKey = new Map(params.findings.map((f) => [findingKey(f), f]));

    await client.query(
      `insert into nightly_reports
         (report_id, run_id, repository, branch, base_sha, head_sha, policy_version, schema_version,
          coverage, required_coverage_complete, summary, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
       on conflict (report_id) do update
         set run_id                     = excluded.run_id,
             coverage                   = excluded.coverage,
             required_coverage_complete = excluded.required_coverage_complete,
             summary                    = excluded.summary,
             updated_at                 = excluded.updated_at`,
      [
        report.reportId,
        params.runId,
        identity.repository,
        identity.branch,
        identity.baseSha,
        identity.headSha,
        identity.policyVersion,
        identity.schemaVersion,
        JSON.stringify(report.coverage),
        report.requiredCoverageComplete,
        JSON.stringify(report.summary),
        now,
      ],
    );

    for (const finding of report.findings) {
      // The full evidence payload for the audit record. Matched on (path, ruleId)
      // — the report finding is a projection of one analyzer finding, and a missing
      // match is stored as null rather than silently substituting another finding.
      const evidence = findingsByKey.get(finding.findingKey) ?? null;

      const proposal = finding.remediation?.proposal ?? null;

      await client.query(
        `insert into nightly_report_findings
           (occurrence_id, report_id, finding_key, rule_id, defect_class, path, start_line, end_line,
            validation, deterministic_support, visibility, visibility_reason, resolution, remediation,
            finding, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)
         on conflict (occurrence_id) do update
           set validation            = excluded.validation,
               deterministic_support = excluded.deterministic_support,
               visibility            = excluded.visibility,
               visibility_reason     = excluded.visibility_reason,
               remediation           = excluded.remediation,
               finding               = excluded.finding,
               updated_at            = excluded.updated_at`,
        [
          finding.occurrenceId,
          report.reportId,
          finding.findingKey,
          finding.ruleId,
          finding.defectClass,
          finding.region.path,
          finding.region.startLine,
          finding.region.endLine,
          finding.validation,
          finding.deterministicSupport,
          finding.visibility,
          finding.visibilityReason,
          finding.resolution,
          finding.remediation === null ? null : JSON.stringify(finding.remediation),
          JSON.stringify(evidence),
          now,
        ],
      );

      // AFTER the finding row: `nightly_fix_proposals.occurrence_id` is a foreign key
      // into it, so writing the proposal first aborts the whole transaction — and with
      // it the entire nightly commit — for any report that carries a fix proposal.
      //
      // Delivery/CI/merge state belongs to the PR lifecycle, not to analysis: a
      // re-commit must never reset a proposal that has already been published. So the
      // proposal row is written (or preserved untouched) and then read back, and the
      // copy embedded in `nightly_report_findings.remediation` is corrected to
      // whatever is actually on record. Without that second write the two desync on a
      // retry whose recomputed report still carries the stale `queued/unknown/open`
      // defaults for a proposal a later brief already published and progressed.
      if (proposal !== null) {
        const authoritative = await client.query<{ delivery: ProposalDelivery; ci: ProposalCiState; merge_state: ProposalMergeState }>(
          `insert into nightly_fix_proposals
             (proposal_id, occurrence_id, provenance, branch, edits, delivery, ci, merge_state, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
           on conflict (proposal_id) do update set updated_at = nightly_fix_proposals.updated_at
           returning delivery, ci, merge_state`,
          [
            proposal.proposalId,
            proposal.occurrenceId,
            JSON.stringify(proposal.provenance),
            proposal.branch,
            JSON.stringify(proposal.edits),
            proposal.delivery,
            proposal.ci,
            proposal.merge,
            now,
          ],
        );
        const onRecord = authoritative.rows[0]!;
        const remediationForStorage = {
          ...finding.remediation!,
          proposal: { ...proposal, delivery: onRecord.delivery, ci: onRecord.ci, merge: onRecord.merge_state },
        };
        await client.query(`update nightly_report_findings set remediation = $2, updated_at = $3 where occurrence_id = $1`, [
          finding.occurrenceId,
          JSON.stringify(remediationForStorage),
          now,
        ]);
      }
    }

    // Parent BEFORE children: a child references its parent, and brief 02 must be
    // able to publish in the same order without inventing an ordering of its own.
    const items = workGraph.parent === null ? [] : [workGraph.parent, ...workGraph.children];
    for (const item of items) {
      await client.query(
        `insert into nightly_work_items
           (work_item_id, report_id, kind, parent_work_item_id, occurrence_id,
            coverage_analyzer_id, coverage_gap_code, title, body, resolution, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
         on conflict (work_item_id) do update
           set title      = excluded.title,
               body       = excluded.body,
               updated_at = excluded.updated_at`,
        [
          item.workItemId,
          item.reportId,
          item.kind,
          item.parentWorkItemId,
          item.occurrenceId,
          item.coverageGap?.analyzerId ?? null,
          item.coverageGap?.code ?? null,
          item.title,
          item.body,
          item.resolution,
          now,
        ],
      );
      // The creation record is pinned to seq 0, so re-committing the same report
      // re-inserts nothing rather than appending a second "created" row.
      await client.query(
        `insert into nightly_work_item_transitions (work_item_id, seq, axis, from_state, to_state, reason, at)
         values ($1, 0, 'resolution', null, $2, 'work item created', $3)
         on conflict (work_item_id, seq) do nothing`,
        [item.workItemId, item.resolution, now],
      );
    }

    // A work item this report no longer needs (e.g. the coverage gap a successor
    // attempt closed) must not sit open forever. Resolve it with a recorded reason
    // rather than deleting it: the audit trail is the product.
    const keep = items.map((item) => item.workItemId);
    const stale = await client.query<{ work_item_id: string; resolution: string }>(
      `update nightly_work_items
          set resolution = 'resolved', updated_at = $2
        where report_id = $1 and resolution = 'open' and not (work_item_id = any($3::text[]))
        returning work_item_id, resolution`,
      [report.reportId, now, keep],
    );
    for (const row of stale.rows) {
      // Appended after the creation record. The guarded update above only returns
      // rows the FIRST time (they are no longer `open` afterwards), so this appends
      // once per real transition rather than on every re-commit.
      await client.query(
        `insert into nightly_work_item_transitions (work_item_id, seq, axis, from_state, to_state, reason, at)
         select $1::text,
                coalesce((select max(seq) from nightly_work_item_transitions where work_item_id = $1::text), -1) + 1,
                'resolution', 'open', 'resolved', $2::text, $3::timestamptz
         on conflict (work_item_id, seq) do nothing`,
        [row.work_item_id, "no longer present in the latest report for this identity", now],
      );
    }
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
