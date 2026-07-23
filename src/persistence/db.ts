import pg from "pg";

/**
 * PostgreSQL is the single authoritative state store (ADR 0003). This module
 * owns the pool and a small transaction helper. Everything durable — runs,
 * transitions, outbox, decisions — goes through here.
 */

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export const DEFAULT_DATABASE_URL = "postgres://scruffy:scruffy@localhost:5433/scruffy";

export function createPool(connectionString = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL): Pool {
  return new pg.Pool({ connectionString, max: 8 });
}

/**
 * Run `fn` inside a single transaction. Commits on success, rolls back on throw.
 * This is the primitive that makes "commit the state transition and its outbox
 * effect atomically" true — both writes happen on the same client/transaction.
 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    client.release();
    return result;
  } catch (err) {
    // Roll back, then return the client to the pool. If ROLLBACK itself fails the
    // connection may be stuck in an aborted transaction; releasing it clean would
    // hand a poisoned connection back to the pool (every later query on it fails
    // with "current transaction is aborted"). Release WITH the error so the pool
    // destroys it instead.
    try {
      await client.query("rollback");
      client.release();
    } catch (rollbackErr) {
      client.release(rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)));
    }
    throw err;
  }
}
