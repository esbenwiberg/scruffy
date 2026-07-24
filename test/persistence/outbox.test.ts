import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/platform/clock.js";
import { createPool } from "../../src/persistence/db.js";
import { migrate } from "../../src/persistence/migrate.js";
import { OutboxStore } from "../../src/persistence/outbox.js";

/**
 * Durable-claim contract: `claimPending` must remove a claimed effect from the
 * claimable set for the whole delivery window, not just the claim transaction,
 * so a concurrent dispatcher cannot re-claim and double-deliver the same effect.
 */

const pool = createPool();
const SUBJECT = { repository: "acme/web", commitSha: "a".repeat(40) };
const LEASE_MS = 5 * 60 * 1000;

let clock: FixedClock;
let outbox: OutboxStore;

beforeEach(async () => {
  await migrate(pool);
  await pool.query("truncate outbox, poison_decisions, run_transitions, evaluation_runs cascade");
  await pool.query(
    `insert into evaluation_runs (id, kind, repository, commit_sha, policy_version, state, attempt, created_at, updated_at)
     values ('run_1', 'poison', $1, $2, 'p1', 'decided', 1, now(), now())`,
    [SUBJECT.repository, SUBJECT.commitSha],
  );
  clock = new FixedClock(new Date("2026-07-15T00:00:00Z"));
  outbox = new OutboxStore(pool, clock);
});

afterAll(async () => {
  await pool.end();
});

async function enqueue(id: string, externalId: string): Promise<void> {
  await pool.query(
    `insert into outbox (id, run_id, effect_type, external_id, payload, status, attempts, created_at)
     values ($1, 'run_1', 'check_run', $2, '{}'::jsonb, 'pending', 0, now())`,
    [id, externalId],
  );
}

describe("OutboxStore.claimPending durability", () => {
  it("does not re-claim an effect that is claimed but not yet marked sent/failed", async () => {
    await enqueue("obx_1", "eff-1");

    const first = await outbox.claimPending(10);
    expect(first.map((r) => r.id)).toEqual(["obx_1"]);

    // A concurrent dispatcher claiming in the delivery window (before markSent)
    // must not re-select the same row, or the external effect double-delivers.
    const second = await outbox.claimPending(10);
    expect(second).toEqual([]);

    // It is out of the pending set entirely, not merely locked.
    expect(await outbox.countPending()).toBe(0);
  });

  it("markSent only settles a row that is currently claimed (processing)", async () => {
    await enqueue("obx_1", "eff-1");
    await outbox.claimPending(10);
    await outbox.markSent("obx_1");

    const { rows } = await pool.query<{ status: string }>("select status from outbox where id = 'obx_1'");
    expect(rows[0]!.status).toBe("sent");
    // A stale markSent for a row no longer processing is a no-op (stays sent).
    await outbox.markSent("obx_1");
    const after = await pool.query<{ status: string }>("select status from outbox where id = 'obx_1'");
    expect(after.rows[0]!.status).toBe("sent");
  });

  it("release returns a transiently-failed effect to the claimable set for the next pass", async () => {
    await enqueue("obx_1", "eff-1");
    const first = await outbox.claimPending(10);
    expect(first[0]!.attempts).toBe(1);

    await outbox.release("obx_1");
    expect(await outbox.countPending()).toBe(1);

    const second = await outbox.claimPending(10);
    expect(second.map((r) => r.id)).toEqual(["obx_1"]);
    expect(second[0]!.attempts).toBe(2);
  });

  it("reclaims an abandoned (dead-dispatcher) claim only after the lease expires", async () => {
    await enqueue("obx_1", "eff-1");
    await outbox.claimPending(10);

    // Still within the lease: not reclaimable.
    clock.advance(LEASE_MS - 1);
    expect(await outbox.claimPending(10)).toEqual([]);

    // Past the lease: the stranded row is reclaimed and retried.
    clock.advance(2);
    const reclaimed = await outbox.claimPending(10);
    expect(reclaimed.map((r) => r.id)).toEqual(["obx_1"]);
  });
});
