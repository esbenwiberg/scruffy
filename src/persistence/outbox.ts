import type { Clock } from "../platform/clock.js";
import type { EffectProduction } from "../domain/findings/work-publication.js";
import { withTransaction, type Pool } from "./db.js";

/** A pending outbox effect awaiting dispatch. */
export interface OutboxRecord {
  id: string;
  runId: string;
  effectType: string;
  externalId: string;
  payload: unknown;
  attempts: number;
  /**
   * The external reference this effect makes available to dependent effects, or
   * null. Carried on the claim so the dispatcher can record a TERMINAL failure
   * against the right work item — and cascade it to whatever was waiting — rather
   * than leaving dependents blocked forever on a reference that will never arrive.
   */
  produces: EffectProduction | null;
}

interface OutboxRow {
  id: string;
  run_id: string;
  effect_type: string;
  external_id: string;
  payload: unknown;
  attempts: number;
  produces_work_item_id: string | null;
  produces: EffectProduction["kind"] | null;
}

/**
 * SQL predicate that is TRUE while an outbox row still has an unsatisfied
 * dependency. It is applied inside `claimPending`, so a dependent effect is never
 * claimed — and therefore can never be delivered or marked sent — before the
 * references it needs are durably on record. Row order is irrelevant.
 *
 * `left join` (not `join`) is deliberate: a work item with no publication row at
 * all has not been attempted, which is unsatisfied for every requirement kind.
 */
const UNSATISFIED_DEPENDENCY = `
  exists (
    select 1
      from outbox_dependencies d
      left join nightly_work_item_publications p on p.work_item_id = d.requires_work_item_id
     where d.outbox_id = candidate.id
       and case d.requires
             when 'issue_reference' then p.external_id is null
             when 'publication_settled' then (p.external_id is null and p.publication_error is null)
             -- A child that could not be filed has nothing left to attach, so its
             -- publication failure settles the attachment too; otherwise the final
             -- reconciliation would wait on an attachment that can never happen.
             when 'attachment_settled' then (
               coalesce(p.attached_to_parent, false) = false
               and p.attachment_error is null
               and p.publication_error is null
             )
             -- Fail CLOSED on a requirement kind this code does not understand (a
             -- newer writer against an older reader). Withholding an effect is
             -- recoverable; delivering one whose precondition was never checked is not.
             else true
           end
  )`;

/**
 * How long a claim is exclusive before it is considered abandoned and becomes
 * re-claimable. `for update skip locked` only holds the row for the lifetime of
 * the claiming transaction, which commits before delivery; the durable
 * `status = 'processing'` marker plus this lease are what keep a second
 * dispatcher from re-claiming and double-delivering during the delivery window.
 * A dispatcher that dies mid-flight strands its rows in `processing`; once the
 * lease expires they are reclaimed and retried (delivery is idempotent on
 * external_id, so re-delivery after a slow-but-alive dispatcher is safe too).
 * Must comfortably exceed the worst-case single-effect delivery time.
 */
const CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * The dispatcher's view of the outbox. Extracted as a port so the effects
 * component is testable against an in-memory double (no Postgres) while
 * `OutboxStore` stays the single production implementation.
 */
export interface OutboxPort {
  claimPending(limit: number): Promise<OutboxRecord[]>;
  markSent(id: string): Promise<void>;
  release(id: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  /**
   * Terminally fail every effect still waiting for a work item's issue reference,
   * and report what those effects would have PRODUCED.
   *
   * Called when the effect that would have produced the reference was
   * dead-lettered: it will never arrive, so a dependent that keeps waiting is a
   * silently stuck effect, and one that is marked sent is a lie. The returned
   * productions are how the caller continues the cascade — a failed parent orphans
   * its children, whose own references then orphan their attachments.
   */
  failDependentsAwaitingReference(workItemId: string, error: string): Promise<EffectProduction[]>;
}

export class OutboxStore implements OutboxPort {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
  ) {}

  /**
   * Claim up to `limit` effects for exclusive processing. The claim is durable:
   * within the claiming transaction the rows are moved to `status = 'processing'`
   * (with `claimed_at`), which removes them from the claimable set for the whole
   * delivery window — not just the transaction. A concurrent dispatcher's
   * `claimPending` therefore cannot re-select and double-deliver them. Rows still
   * in `processing` past `CLAIM_LEASE_MS` are treated as abandoned (dead
   * dispatcher) and reclaimed. Claiming bumps `attempts` so a poison-pill effect
   * cannot loop forever unnoticed.
   */
  async claimPending(limit: number): Promise<OutboxRecord[]> {
    const now = this.clock.now();
    const leaseCutoff = new Date(now.getTime() - CLAIM_LEASE_MS);
    return withTransaction(this.pool, async (client) => {
      const claimed = await client.query<OutboxRow>(
        `update outbox
            set status = 'processing', attempts = attempts + 1, claimed_at = $2
          where id in (
            select candidate.id from outbox candidate
              where (candidate.status = 'pending'
                 or (candidate.status = 'processing' and candidate.claimed_at < $3))
                and not ${UNSATISFIED_DEPENDENCY}
              order by candidate.created_at
              -- "of candidate": the dependency predicate joins the publication
              -- table, and an unqualified FOR UPDATE would try to lock rows we
              -- only read.
              for update of candidate skip locked
              limit $1
          )
          returning *`,
        [limit, now, leaseCutoff],
      );
      // `returning *` yields the post-update row, so `attempts` is already bumped.
      return claimed.rows.map(toRecord);
    });
  }

  async markSent(id: string): Promise<void> {
    await this.pool.query(`update outbox set status = 'sent', sent_at = $2 where id = $1 and status = 'processing'`, [
      id,
      this.clock.now(),
    ]);
  }

  /**
   * Return a claimed (`processing`) effect to the claimable set after a transient
   * failure so it is retried on the next pass. Without this the row would stay
   * `processing` until its lease expires; releasing restores the immediate
   * next-pass retry the dispatcher's attempt-budget logic relies on.
   */
  async release(id: string): Promise<void> {
    await this.pool.query(`update outbox set status = 'pending', claimed_at = null where id = $1 and status = 'processing'`, [id]);
  }

  /**
   * Dead-letter an effect that cannot be delivered: a permanent error (unknown
   * type / unparseable payload) or a transient one that has exhausted its
   * attempts. It transitions the row out of `processing` to the terminal
   * `failed` state, so it is never re-claimed, and records why. This is the
   * backstop that makes bumping `attempts` mean something.
   */
  async markFailed(id: string, error: string): Promise<void> {
    await this.pool.query(`update outbox set status = 'failed', last_error = $2 where id = $1 and status = 'processing'`, [
      id,
      error.slice(0, 2000),
    ]);
  }

  /**
   * Cascade a terminal publication failure to whatever was waiting for that issue
   * reference. Bounded to non-terminal rows (`pending`/`processing`) so an already
   * sent or already dead-lettered effect is never rewritten, and `last_error`
   * records the upstream reason so the dead letter explains itself.
   */
  async failDependentsAwaitingReference(workItemId: string, error: string): Promise<EffectProduction[]> {
    const updated = await this.pool.query<{ produces_work_item_id: string | null; produces: EffectProduction["kind"] | null }>(
      `update outbox
          set status = 'failed', last_error = $2
        where status in ('pending', 'processing')
          and id in (
            select outbox_id from outbox_dependencies
              where requires_work_item_id = $1 and requires = 'issue_reference'
          )
        returning produces_work_item_id, produces`,
      [workItemId, `dependency ${workItemId} will never be published: ${error}`.slice(0, 2000)],
    );
    return updated.rows.flatMap((row) =>
      row.produces_work_item_id !== null && row.produces !== null
        ? [{ workItemId: row.produces_work_item_id, kind: row.produces }]
        : [],
    );
  }

  async countPending(): Promise<number> {
    const r = await this.pool.query<{ count: string }>(`select count(*)::text as count from outbox where status = 'pending'`);
    return Number(r.rows[0]!.count);
  }

  /**
   * Pending effects that cannot yet be claimed because a dependency is unsatisfied.
   * Ops/test visibility: a non-zero count with an idle dispatcher means a reference
   * is missing, not that the queue is drained.
   */
  async countBlocked(): Promise<number> {
    const r = await this.pool.query<{ count: string }>(
      `select count(*)::text as count from outbox candidate
        where candidate.status = 'pending' and ${UNSATISFIED_DEPENDENCY}`,
    );
    return Number(r.rows[0]!.count);
  }

  async countFailed(): Promise<number> {
    const r = await this.pool.query<{ count: string }>(`select count(*)::text as count from outbox where status = 'failed'`);
    return Number(r.rows[0]!.count);
  }
}

function toRecord(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    runId: row.run_id,
    effectType: row.effect_type,
    externalId: row.external_id,
    payload: row.payload,
    attempts: row.attempts,
    produces:
      row.produces_work_item_id !== null && row.produces !== null
        ? { workItemId: row.produces_work_item_id, kind: row.produces }
        : null,
  };
}
