import { z } from "zod";
import type { Clock } from "../platform/clock.js";
import { PreconditionedEdit } from "../domain/fixes/delivery.js";
import {
  ExternalDismissal,
  FindingVerification,
  type ParentChildState,
} from "../domain/fixes/lifecycle.js";
import {
  FindingResolution,
  NightlyWorkItemKind,
  ProposalCiState,
  ProposalDelivery,
  ProposalMergeState,
} from "../domain/findings/work-graph.js";
import { IssueExternalRef } from "../domain/findings/work-publication.js";
import type { Pool } from "./db.js";
import { withTransaction } from "./db.js";

/**
 * Durable store for FIX DELIVERY and RESOLUTION.
 *
 * This is the half the outbox used to throw away: the provider's pull-request
 * result, and everything that happens to a PR afterwards. It exists so four
 * things are true at once —
 *
 *  - a delivered proposal names its PR, so reconciliation has something to read;
 *  - a CI verdict is inseparable from the commit it was observed on, so a
 *    force-push cannot leave an old green result attached to a new patch;
 *  - a merge is recorded as a merge and nothing more, with post-merge
 *    verification stored per immutable subject sha;
 *  - a human's dismissal is stored as a dismissal, with whatever actor/reason the
 *    provider gave, and is never re-rendered as "Scruffy verified this fixed".
 *
 * Every read parses through the domain schemas: these rows drive an issue body, a
 * check summary, and whether a parent closes, so a half-written row must fail
 * loudly rather than render as progress.
 */

// ── Records ─────────────────────────────────────────────────────────────────

/** Provider handles for a delivered pull request. */
export const DeliveredPullRequest = z.object({
  number: z.number().int().positive(),
  url: z.string().min(1),
  /** PR head sha at the last observation. CI is only current when it matches. */
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  draft: z.boolean(),
});
export type DeliveredPullRequest = z.infer<typeof DeliveredPullRequest>;

/**
 * One proposal plus everything reconciliation needs about it, without a join.
 *
 * `edits` is carried because post-merge verification is FINDING-SPECIFIC: a
 * deterministic verifier re-reads the touched path at the post-merge head and
 * checks the patch actually took, and it cannot do that from a state enum.
 */
export const FixDeliveryRecord = z.object({
  proposalId: z.string().min(1),
  occurrenceId: z.string().min(1),
  reportId: z.string().min(1),
  /** Child work item (and therefore child issue) this proposal remediates. */
  workItemId: z.string().min(1).nullable(),
  repository: z.string().min(1),
  /** The branch the review ran on — also the post-merge verification subject. */
  baseBranch: z.string().min(1).nullable(),
  /** The candidate-bound fix branch. */
  branch: z.string().min(1),
  reviewedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
  reviewedBaseSha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  defectClass: z.string().min(1),
  ruleId: z.string().min(1),
  path: z.string().min(1),
  edits: z.array(PreconditionedEdit),
  delivery: ProposalDelivery,
  ci: ProposalCiState,
  ciHeadSha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  merge: ProposalMergeState,
  pr: DeliveredPullRequest.nullable(),
  deliveryError: z.string().min(1).nullable(),
  mergeCommitSha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  resolution: FindingResolution,
});
export type FixDeliveryRecord = z.infer<typeof FixDeliveryRecord>;

export interface RecordDeliveryInput {
  proposalId: string;
  delivery: Extract<ProposalDelivery, "draft_open" | "ready_open">;
  pr: DeliveredPullRequest;
}

export interface RecordObservationInput {
  proposalId: string;
  delivery: ProposalDelivery;
  ci: ProposalCiState;
  /** Non-null exactly when `ci` is not `unknown` — the commit it was seen on. */
  ciHeadSha: string | null;
  merge: ProposalMergeState;
  pr: DeliveredPullRequest;
  mergeCommitSha: string | null;
}

/** The delivery half of a child's durable state, when it has a proposal at all. */
export interface ChildProposalState {
  proposalId: string;
  delivery: ProposalDelivery;
  ci: ProposalCiState;
  ciHeadSha: string | null;
  merge: ProposalMergeState;
  pr: { number: number; url: string } | null;
  deliveryError: string | null;
}

/**
 * One child as resolution derivation, issue rendering, and parent closure all need
 * it. Everything is read from durable rows rather than recomputed from the
 * provider: the issue body a human reads must be a projection of what Scruffy
 * actually recorded, or the two drift and the issue becomes the more persuasive lie.
 */
export interface ReportChildState extends ParentChildState {
  /** Drives the issue labels the refresh re-applies (the lookup is label-scoped). */
  kind: NightlyWorkItemKind;
  /** The planned body. Lifecycle state is appended to it, never stored inside it. */
  body: string;
  occurrenceId: string | null;
  issue: IssueExternalRef | null;
  proposal: ChildProposalState | null;
  /** A human's recorded external closure, or null. */
  dismissal: ExternalDismissal | null;
  /** The most recent post-merge verification for this occurrence, or null. */
  verification: FindingVerification | null;
}

export interface ReportClosureView {
  reportId: string;
  repository: string;
  branch: string;
  /** The reviewed candidate — the check run this report owns is bound to it. */
  headSha: string;
  requiredCoverageComplete: boolean;
  parent: { workItemId: string; title: string; body: string; issue: IssueExternalRef | null } | null;
  children: ReportChildState[];
}

export interface NightlyFixLifecyclePort {
  /** Persist the provider's PR result. Idempotent on `proposalId`. */
  recordDeliveryResult(input: RecordDeliveryInput): Promise<void>;
  /**
   * Record a TERMINAL delivery failure (refused patch, colliding branch,
   * dead-lettered effect). Never overwrites a delivered PR: a proposal whose PR
   * exists must not be reported to a human as undelivered.
   */
  recordDeliveryFailure(proposalId: string, reason: string): Promise<boolean>;
  /** Proposals with a PR whose lifecycle has not reached a terminal resolution. */
  proposalsToReconcile(limit: number): Promise<FixDeliveryRecord[]>;
  /** Persist an observation of provider state, appending axis transitions. */
  recordObservation(input: RecordObservationInput): Promise<void>;
  /** Persist a verification of one occurrence at one immutable subject sha. */
  recordVerification(occurrenceId: string, verification: FindingVerification): Promise<void>;
  /** The verification for exactly `subjectSha`, or null. Never a fuzzy match. */
  getVerification(occurrenceId: string, subjectSha: string): Promise<FindingVerification | null>;
  /** Record a human's external closure of a work item as a dismissal. */
  recordDismissal(workItemId: string, dismissal: ExternalDismissal): Promise<void>;
  /**
   * Set the durable resolution of a finding occurrence and its work item.
   * `occurrenceId` is null for a coverage-gap child, which has a work item but no
   * finding row.
   */
  setResolution(input: {
    occurrenceId: string | null;
    workItemId: string | null;
    resolution: FindingResolution;
    reason: string;
  }): Promise<void>;
  /** Reports whose parent work item is still open, for closure derivation. */
  openReports(limit: number): Promise<ReportClosureView[]>;
  /** Close a parent work item once closure has been derived. */
  closeParent(workItemId: string, reason: string): Promise<void>;
}

// ── Postgres implementation ─────────────────────────────────────────────────

interface ProposalRow {
  proposal_id: string;
  occurrence_id: string;
  report_id: string;
  work_item_id: string | null;
  repository: string | null;
  base_branch: string | null;
  branch: string;
  reviewed_head_sha: string | null;
  reviewed_base_sha: string | null;
  defect_class: string;
  rule_id: string;
  path: string;
  edits: unknown;
  delivery: string;
  ci: string;
  ci_head_sha: string | null;
  merge_state: string;
  pr_number: number | null;
  pr_url: string | null;
  pr_head_sha: string | null;
  pr_draft: boolean | null;
  delivery_error: string | null;
  merge_commit_sha: string | null;
  resolution: string;
  report_head_sha: string;
  report_branch: string;
  report_repository: string;
}

export class FixLifecycleStore implements NightlyFixLifecyclePort {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
  ) {}

  /**
   * Idempotent on proposal_id. The PR handles are rewritten from the provider's
   * answer on every dispatch (a matched existing PR returns the same number), and
   * `delivered_at` is preserved so a retry does not restate when delivery happened.
   *
   * `delivery_error` is cleared: a later success is the truth, and the SQL check
   * refuses to hold a failure alongside a non-failed delivery anyway.
   */
  async recordDeliveryResult(input: RecordDeliveryInput): Promise<void> {
    const now = this.clock.now();
    await withTransaction(this.pool, async (client) => {
      const updated = await client.query<{ delivery: string }>(
        `update nightly_fix_proposals
            set delivery       = $2,
                pr_number      = $3,
                pr_url         = $4,
                pr_head_sha    = $5,
                pr_draft       = $6,
                delivery_error = null,
                delivered_at   = coalesce(delivered_at, $7),
                updated_at     = $7
          where proposal_id = $1
            and (delivery is distinct from $2
                 or pr_number is distinct from $3
                 or pr_head_sha is distinct from $5
                 or pr_draft is distinct from $6
                 or delivery_error is not null)
          returning delivery`,
        [input.proposalId, input.delivery, input.pr.number, input.pr.url, input.pr.headSha, input.pr.draft, now],
      );
      if (updated.rows.length === 0) return; // nothing changed — no transition to append
      await this.#appendTransition(client, input.proposalId, "delivery", input.delivery, "pull request delivered", null, now);
    });
  }

  async recordDeliveryFailure(proposalId: string, reason: string): Promise<boolean> {
    const now = this.clock.now();
    return withTransaction(this.pool, async (client) => {
      const updated = await client.query(
        `update nightly_fix_proposals
            set delivery       = 'delivery_failed',
                delivery_error = $2,
                updated_at     = $3
          where proposal_id = $1
            -- Guarded: a proposal whose PR exists is delivered, whatever a later
            -- effect attempt says. Downgrading it would tell a human there is no
            -- pull request when there is one.
            and pr_number is null
            and delivery is distinct from 'delivery_failed'`,
        [proposalId, reason, now],
      );
      if (updated.rowCount === 0) return false;
      await this.#appendTransition(client, proposalId, "delivery", "delivery_failed", reason, null, now);
      return true;
    });
  }

  /**
   * Proposals that still need watching: a PR exists and the finding has not
   * reached a terminal resolution. A merged-and-verified or dismissed finding
   * drops out, so reconciliation does not re-poll settled work forever.
   */
  async proposalsToReconcile(limit: number): Promise<FixDeliveryRecord[]> {
    const result = await this.pool.query<ProposalRow>(
      `select p.proposal_id, p.occurrence_id, f.report_id, p.work_item_id,
              p.repository, p.base_branch, p.branch, p.reviewed_head_sha, p.reviewed_base_sha,
              f.defect_class, f.rule_id, f.path, p.edits,
              p.delivery, p.ci, p.ci_head_sha, p.merge_state,
              p.pr_number, p.pr_url, p.pr_head_sha, p.pr_draft, p.delivery_error, p.merge_commit_sha,
              f.resolution,
              r.head_sha as report_head_sha, r.branch as report_branch, r.repository as report_repository
         from nightly_fix_proposals p
         join nightly_report_findings f on f.occurrence_id = p.occurrence_id
         join nightly_reports r on r.report_id = f.report_id
        where p.pr_number is not null
          and f.resolution not in ('resolved', 'dismissed')
        order by p.updated_at asc
        limit $1`,
      [limit],
    );
    return result.rows.map((row) => this.#toRecord(row));
  }

  async recordObservation(input: RecordObservationInput): Promise<void> {
    const now = this.clock.now();
    await withTransaction(this.pool, async (client) => {
      const current = await client.query<{ delivery: string; ci: string; ci_head_sha: string | null; merge_state: string }>(
        `select delivery, ci, ci_head_sha, merge_state from nightly_fix_proposals where proposal_id = $1 for update`,
        [input.proposalId],
      );
      const before = current.rows[0];
      if (!before) return;

      await client.query(
        `update nightly_fix_proposals
            set delivery         = $2,
                ci               = $3,
                ci_head_sha      = $4,
                merge_state      = $5,
                pr_number        = $6,
                pr_url           = $7,
                pr_head_sha      = $8,
                pr_draft         = $9,
                merge_commit_sha = $10,
                merged_at        = case when $5 = 'merged' then coalesce(merged_at, $11) else merged_at end,
                updated_at       = $11
          where proposal_id = $1`,
        [
          input.proposalId,
          input.delivery,
          input.ci,
          input.ciHeadSha,
          input.merge,
          input.pr.number,
          input.pr.url,
          input.pr.headSha,
          input.pr.draft,
          input.mergeCommitSha,
          now,
        ],
      );

      if (before.delivery !== input.delivery) {
        await this.#appendTransition(client, input.proposalId, "delivery", input.delivery, "observed provider state", null, now, before.delivery);
      }
      // A CI transition is recorded when the verdict OR the commit it belongs to
      // changed: same verdict on a new head is new evidence, not a no-op.
      if (before.ci !== input.ci || before.ci_head_sha !== input.ciHeadSha) {
        await this.#appendTransition(
          client,
          input.proposalId,
          "ci",
          input.ci,
          input.ciHeadSha === null ? `no evidence for head ${input.pr.headSha}` : `repository CI at ${input.ciHeadSha}`,
          // The `ci` axis requires an evidence sha; when there is no verdict for the
          // current head, the PR head itself is the commit the absence is about.
          input.ciHeadSha ?? input.pr.headSha,
          now,
          before.ci,
        );
      }
      if (before.merge_state !== input.merge) {
        await this.#appendTransition(
          client,
          input.proposalId,
          "merge",
          input.merge,
          input.merge === "merged" ? `merged as ${input.mergeCommitSha ?? "unknown commit"}` : "observed provider state",
          input.mergeCommitSha,
          now,
          before.merge_state,
        );
      }
    });
  }

  async recordVerification(occurrenceId: string, verification: FindingVerification): Promise<void> {
    await this.pool.query(
      `insert into nightly_finding_verifications (occurrence_id, subject_sha, outcome, detail, verifier_id, at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (occurrence_id, subject_sha) do update
         set outcome     = excluded.outcome,
             detail      = excluded.detail,
             verifier_id = excluded.verifier_id,
             at          = excluded.at`,
      [
        occurrenceId,
        verification.subjectSha,
        verification.outcome,
        verification.detail,
        verification.verifierId,
        this.clock.now(),
      ],
    );
  }

  async getVerification(occurrenceId: string, subjectSha: string): Promise<FindingVerification | null> {
    const result = await this.pool.query<{ outcome: string; detail: string; verifier_id: string }>(
      `select outcome, detail, verifier_id
         from nightly_finding_verifications
        where occurrence_id = $1 and subject_sha = $2`,
      [occurrenceId, subjectSha],
    );
    const row = result.rows[0];
    if (!row) return null;
    return FindingVerification.parse({
      outcome: row.outcome,
      detail: row.detail,
      subjectSha,
      verifierId: row.verifier_id,
    });
  }

  async recordDismissal(workItemId: string, dismissal: ExternalDismissal): Promise<void> {
    await this.pool.query(
      `update nightly_work_items
          set dismissal_actor  = $2,
              dismissal_reason = $3,
              dismissed_at     = coalesce(dismissed_at, $4),
              updated_at       = $4
        where work_item_id = $1 and dismissed_at is null`,
      [workItemId, dismissal.actor, dismissal.stateReason, dismissal.at],
    );
  }

  async setResolution(input: {
    occurrenceId: string | null;
    workItemId: string | null;
    resolution: FindingResolution;
    reason: string;
  }): Promise<void> {
    const now = this.clock.now();
    await withTransaction(this.pool, async (client) => {
      if (input.occurrenceId !== null) {
        await client.query(
          `update nightly_report_findings
              set resolution = $2, updated_at = $3
            where occurrence_id = $1 and resolution is distinct from $2`,
          [input.occurrenceId, input.resolution, now],
        );
      }
      if (input.workItemId === null) return;
      const before = await client.query<{ resolution: string }>(
        `select resolution from nightly_work_items where work_item_id = $1 for update`,
        [input.workItemId],
      );
      const previous = before.rows[0]?.resolution;
      if (previous === undefined || previous === input.resolution) return;
      await client.query(`update nightly_work_items set resolution = $2, updated_at = $3 where work_item_id = $1`, [
        input.workItemId,
        input.resolution,
        now,
      ]);
      await client.query(
        `insert into nightly_work_item_transitions (work_item_id, seq, axis, from_state, to_state, reason, at)
         select $1,
                coalesce((select max(seq) from nightly_work_item_transitions where work_item_id = $1), -1) + 1,
                'resolution', $2, $3, $4, $5
         on conflict (work_item_id, seq) do nothing`,
        [input.workItemId, previous, input.resolution, input.reason, now],
      );
    });
  }

  async openReports(limit: number): Promise<ReportClosureView[]> {
    const parents = await this.pool.query<{
      report_id: string;
      repository: string;
      branch: string;
      head_sha: string;
      required_coverage_complete: boolean;
      work_item_id: string;
      title: string;
      body: string;
      external_number: number | null;
      external_id: string | null;
      external_url: string | null;
    }>(
      `select r.report_id, r.repository, r.branch, r.head_sha, r.required_coverage_complete,
              w.work_item_id, w.title, w.body,
              pub.external_number, pub.external_id, pub.external_url
         from nightly_work_items w
         join nightly_reports r on r.report_id = w.report_id
         left join nightly_work_item_publications pub on pub.work_item_id = w.work_item_id
        where w.kind = 'nightly_run' and w.resolution = 'open'
        order by r.created_at asc
        limit $1`,
      [limit],
    );

    const views: ReportClosureView[] = [];
    for (const parent of parents.rows) {
      const children = await this.pool.query<ChildRow>(
        // The verification join is LATERAL and ordered: a finding may be verified
        // more than once (each post-merge head is its own immutable subject), and
        // the current answer is the newest one — never an older, more convenient one.
        `select w.work_item_id, w.kind, w.title, w.body, w.resolution, w.occurrence_id,
                w.dismissal_actor, w.dismissal_reason, w.dismissed_at,
                p.proposal_id, p.delivery, p.ci, p.ci_head_sha, p.merge_state,
                p.pr_number, p.pr_url, p.delivery_error,
                pub.publication_error, pub.external_number, pub.external_id, pub.external_url,
                v.outcome as verification_outcome, v.detail as verification_detail,
                v.subject_sha as verification_subject_sha, v.verifier_id as verification_verifier_id
           from nightly_work_items w
           left join nightly_fix_proposals p on p.work_item_id = w.work_item_id
           left join nightly_work_item_publications pub on pub.work_item_id = w.work_item_id
           left join lateral (
             select outcome, detail, subject_sha, verifier_id
               from nightly_finding_verifications nv
              where nv.occurrence_id = w.occurrence_id
              order by nv.at desc
              limit 1
           ) v on true
          where w.report_id = $1 and w.kind <> 'nightly_run'
          order by w.work_item_id asc`,
        [parent.report_id],
      );
      views.push({
        reportId: parent.report_id,
        repository: parent.repository,
        branch: parent.branch,
        headSha: parent.head_sha,
        requiredCoverageComplete: parent.required_coverage_complete,
        parent: {
          workItemId: parent.work_item_id,
          title: parent.title,
          body: parent.body,
          issue: toIssueRef(parent.external_number, parent.external_id, parent.external_url),
        },
        children: children.rows.map((child) => toChildState(child)),
      });
    }
    return views;
  }

  async closeParent(workItemId: string, reason: string): Promise<void> {
    const now = this.clock.now();
    await withTransaction(this.pool, async (client) => {
      const updated = await client.query(
        `update nightly_work_items set resolution = 'resolved', updated_at = $2
          where work_item_id = $1 and kind = 'nightly_run' and resolution = 'open'`,
        [workItemId, now],
      );
      if (updated.rowCount === 0) return;
      await client.query(
        `insert into nightly_work_item_transitions (work_item_id, seq, axis, from_state, to_state, reason, at)
         select $1,
                coalesce((select max(seq) from nightly_work_item_transitions where work_item_id = $1), -1) + 1,
                'resolution', 'open', 'resolved', $2, $3
         on conflict (work_item_id, seq) do nothing`,
        [workItemId, reason, now],
      );
    });
  }

  /**
   * Append one axis transition. `seq` is derived inside the same transaction from
   * the existing maximum, and `(proposal_id, seq)` is unique, so a concurrent
   * appender collides rather than silently interleaving a duplicate history.
   */
  async #appendTransition(
    client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
    proposalId: string,
    axis: "delivery" | "ci" | "merge",
    to: string,
    reason: string,
    evidenceSha: string | null,
    at: Date,
    from: string | null = null,
  ): Promise<void> {
    await client.query(
      `insert into nightly_fix_proposal_transitions
         (proposal_id, seq, axis, from_state, to_state, reason, evidence_sha, at)
       select $1,
              coalesce((select max(seq) from nightly_fix_proposal_transitions where proposal_id = $1), -1) + 1,
              $2, $3, $4, $5, $6, $7
       on conflict (proposal_id, seq) do nothing`,
      [proposalId, axis, from, to, reason, evidenceSha, at],
    );
  }

  #toRecord(row: ProposalRow): FixDeliveryRecord {
    return FixDeliveryRecord.parse({
      proposalId: row.proposal_id,
      occurrenceId: row.occurrence_id,
      reportId: row.report_id,
      workItemId: row.work_item_id,
      repository: row.repository ?? row.report_repository,
      baseBranch: row.base_branch ?? row.report_branch,
      branch: row.branch,
      reviewedHeadSha: row.reviewed_head_sha ?? row.report_head_sha,
      reviewedBaseSha: row.reviewed_base_sha,
      defectClass: row.defect_class,
      ruleId: row.rule_id,
      path: row.path,
      edits: row.edits,
      delivery: row.delivery,
      ci: row.ci,
      ciHeadSha: row.ci_head_sha,
      merge: row.merge_state,
      pr:
        row.pr_number === null || row.pr_url === null || row.pr_head_sha === null || row.pr_draft === null
          ? null
          : { number: row.pr_number, url: row.pr_url, headSha: row.pr_head_sha, draft: row.pr_draft },
      deliveryError: row.delivery_error,
      mergeCommitSha: row.merge_commit_sha,
      resolution: row.resolution,
    });
  }
}

interface ChildRow {
  work_item_id: string;
  kind: string;
  title: string;
  body: string;
  resolution: string;
  occurrence_id: string | null;
  dismissal_actor: string | null;
  dismissal_reason: string | null;
  dismissed_at: Date | null;
  proposal_id: string | null;
  delivery: string | null;
  ci: string | null;
  ci_head_sha: string | null;
  merge_state: string | null;
  pr_number: number | null;
  pr_url: string | null;
  delivery_error: string | null;
  publication_error: string | null;
  external_number: number | null;
  external_id: string | null;
  external_url: string | null;
  verification_outcome: string | null;
  verification_detail: string | null;
  verification_subject_sha: string | null;
  verification_verifier_id: string | null;
}

function toChildState(row: ChildRow): ReportChildState {
  return {
    workItemId: row.work_item_id,
    kind: NightlyWorkItemKind.parse(row.kind),
    title: row.title,
    body: row.body,
    resolution: FindingResolution.parse(row.resolution),
    deliveryFailed: row.delivery === "delivery_failed",
    publicationFailed: row.publication_error !== null,
    occurrenceId: row.occurrence_id,
    issue: toIssueRef(row.external_number, row.external_id, row.external_url),
    proposal:
      row.proposal_id === null
        ? null
        : {
            proposalId: row.proposal_id,
            delivery: ProposalDelivery.parse(row.delivery),
            ci: ProposalCiState.parse(row.ci),
            ciHeadSha: row.ci_head_sha,
            merge: ProposalMergeState.parse(row.merge_state),
            pr: row.pr_number === null || row.pr_url === null ? null : { number: row.pr_number, url: row.pr_url },
            deliveryError: row.delivery_error,
          },
    // `dismissed_at` is the fact; actor and reason are whatever GitHub was willing
    // to tell us, and a dismissal with neither is still a dismissal.
    dismissal:
      row.dismissed_at === null
        ? null
        : ExternalDismissal.parse({ actor: row.dismissal_actor, stateReason: row.dismissal_reason, at: row.dismissed_at }),
    verification:
      row.verification_outcome === null || row.verification_subject_sha === null
        ? null
        : FindingVerification.parse({
            outcome: row.verification_outcome,
            detail: row.verification_detail,
            subjectSha: row.verification_subject_sha,
            verifierId: row.verification_verifier_id,
          }),
  };
}

function toIssueRef(number: number | null, id: string | null, url: string | null): IssueExternalRef | null {
  if (number === null || id === null || url === null) return null;
  return IssueExternalRef.parse({ provider: "github", number, externalId: id, url });
}
