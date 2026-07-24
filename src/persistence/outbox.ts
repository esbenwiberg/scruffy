import type { Clock } from "../platform/clock.js";
import { withTransaction, type Pool } from "./db.js";

/** A pending outbox effect awaiting dispatch. */
export interface OutboxRecord {
  id: string;
  runId: string;
  effectType: string;
  externalId: string;
  payload: unknown;
  attempts: number;
}

interface OutboxRow {
  id: string;
  run_id: string;
  effect_type: string;
  external_id: string;
  payload: unknown;
  attempts: number;
}

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

export class OutboxStore {
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
            select id from outbox
              where status = 'pending'
                 or (status = 'processing' and claimed_at < $3)
              order by created_at
              for update skip locked
              limit $1
          )
          returning *`,
        [limit, now, leaseCutoff],
      );
      // `returning *` yields the post-update row, so `attempts` is already bumped.
      return claimed.rows.map((r) => ({
        id: r.id,
        runId: r.run_id,
        effectType: r.effect_type,
        externalId: r.external_id,
        payload: r.payload,
        attempts: r.attempts,
      }));
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

  async countPending(): Promise<number> {
    const r = await this.pool.query<{ count: string }>(`select count(*)::text as count from outbox where status = 'pending'`);
    return Number(r.rows[0]!.count);
  }

  async countFailed(): Promise<number> {
    const r = await this.pool.query<{ count: string }>(`select count(*)::text as count from outbox where status = 'failed'`);
    return Number(r.rows[0]!.count);
  }
}
