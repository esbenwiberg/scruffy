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

export class OutboxStore {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
  ) {}

  /**
   * Claim up to `limit` pending effects for exclusive processing. `for update
   * skip locked` lets multiple dispatcher instances run without contending for
   * the same rows. Claiming bumps `attempts` so a poison-pill effect cannot loop
   * forever unnoticed.
   */
  async claimPending(limit: number): Promise<OutboxRecord[]> {
    return withTransaction(this.pool, async (client) => {
      const claimed = await client.query<OutboxRow>(
        `select * from outbox
           where status = 'pending'
           order by created_at
           for update skip locked
           limit $1`,
        [limit],
      );
      if (claimed.rowCount === 0) return [];
      const ids = claimed.rows.map((r) => r.id);
      await client.query(`update outbox set attempts = attempts + 1 where id = any($1)`, [ids]);
      return claimed.rows.map((r) => ({
        id: r.id,
        runId: r.run_id,
        effectType: r.effect_type,
        externalId: r.external_id,
        payload: r.payload,
        attempts: r.attempts + 1,
      }));
    });
  }

  async markSent(id: string): Promise<void> {
    await this.pool.query(`update outbox set status = 'sent', sent_at = $2 where id = $1`, [id, this.clock.now()]);
  }

  /**
   * Dead-letter an effect that cannot be delivered: a permanent error (unknown
   * type / unparseable payload) or a transient one that has exhausted its
   * attempts. It leaves `pending`, so it is never re-claimed, and records why.
   * This is the backstop that makes bumping `attempts` mean something.
   */
  async markFailed(id: string, error: string): Promise<void> {
    await this.pool.query(`update outbox set status = 'failed', last_error = $2 where id = $1`, [id, error.slice(0, 2000)]);
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
