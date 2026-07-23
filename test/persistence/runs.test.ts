import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock, SeededIdGenerator } from "../../src/platform/clock.js";
import { createPool } from "../../src/persistence/db.js";
import { migrate } from "../../src/persistence/migrate.js";
import { RunStore } from "../../src/persistence/runs.js";
import type { PoisonDecision } from "../../src/gates/poison/decision.js";

/**
 * Durability guarantees behind ADR 0003 validations #3 (atomic transition +
 * outbox) and #4 (guarded, idempotent transitions).
 */

const pool = createPool();
const SUBJECT = { repository: "acme/web", commitSha: "a".repeat(40) };
const DECISION: PoisonDecision = { outcome: "allow", reasons: ["no_blockable_findings"], dispositions: [] };

let runs: RunStore;
let clock: FixedClock;

beforeEach(async () => {
  await migrate(pool);
  await pool.query("truncate outbox, poison_decisions, run_transitions, evaluation_runs cascade");
  clock = new FixedClock(new Date("2026-07-15T00:00:00Z"));
  runs = new RunStore(pool, clock, new SeededIdGenerator("t"));
});

afterAll(async () => {
  await pool.end();
});

describe("RunStore durability", () => {
  it("ensureRun is idempotent for the same subject+kind", async () => {
    const a = await runs.ensureRun(SUBJECT, "poison", "p1");
    const b = await runs.ensureRun(SUBJECT, "poison", "p1");
    expect(b.id).toBe(a.id);
    const count = await pool.query("select count(*) from evaluation_runs");
    expect(count.rows[0].count).toBe("1");
  });

  it("guarded transition applies once; a second identical transition is a no-op", async () => {
    const run = await runs.ensureRun(SUBJECT, "poison", "p1");
    expect(await runs.transition(run.id, "pending", "analyzing", "start")).toBe(true);
    expect(await runs.transition(run.id, "pending", "analyzing", "start-again")).toBe(false);
    const after = await runs.getRun(run.id);
    expect(after?.state).toBe("analyzing");
  });

  it("commitDecision writes transition, decision, and outbox atomically", async () => {
    const run = await runs.ensureRun(SUBJECT, "poison", "p1");
    await runs.transition(run.id, "pending", "analyzing", "start");
    const applied = await runs.commitDecision({
      runId: run.id,
      from: "analyzing",
      to: "decided",
      reason: "poison allow",
      decision: DECISION,
      findings: [],
      effect: { effectType: "check_run", externalId: "poison:acme/web:sha", payload: { hello: "world" } },
    });
    expect(applied).toBe(true);

    expect((await runs.getRun(run.id))?.state).toBe("decided");
    expect((await pool.query("select count(*) from poison_decisions")).rows[0].count).toBe("1");
    expect((await pool.query("select count(*) from outbox")).rows[0].count).toBe("1");
  });

  it("commitDecision from the wrong state applies nothing (no decision, no outbox row)", async () => {
    const run = await runs.ensureRun(SUBJECT, "poison", "p1");
    // Run is still 'pending', not 'analyzing' — the guard must reject.
    const applied = await runs.commitDecision({
      runId: run.id,
      from: "analyzing",
      to: "decided",
      reason: "poison allow",
      decision: DECISION,
      findings: [],
      effect: { effectType: "check_run", externalId: "x", payload: {} },
    });
    expect(applied).toBe(false);
    expect((await pool.query("select count(*) from poison_decisions")).rows[0].count).toBe("0");
    expect((await pool.query("select count(*) from outbox")).rows[0].count).toBe("0");
    expect((await runs.getRun(run.id))?.state).toBe("pending");
  });

  it("claimForAnalysis returns a fresh fencing token, and a wrong token cannot commit", async () => {
    const run = await runs.ensureRun(SUBJECT, "poison", "p1");
    const lease = await runs.claimForAnalysis(run.id, "worker-a", 60_000);
    expect(lease).not.toBeNull();

    // A commit fenced on the WRONG token touches nothing.
    const wrong = await runs.commitDecision({
      runId: run.id,
      from: "analyzing",
      to: "decided",
      reason: "poison allow",
      decision: DECISION,
      findings: [],
      effect: { effectType: "check_run", externalId: "x", payload: {} },
      fenceLease: "lease_not_mine",
    });
    expect(wrong).toBe(false);
    expect((await runs.getRun(run.id))?.state).toBe("analyzing");
    expect((await pool.query("select count(*) from poison_decisions")).rows[0].count).toBe("0");

    // The real token commits.
    const right = await runs.commitDecision({
      runId: run.id,
      from: "analyzing",
      to: "decided",
      reason: "poison allow",
      decision: DECISION,
      findings: [],
      effect: { effectType: "check_run", externalId: "x", payload: {} },
      fenceLease: lease!,
    });
    expect(right).toBe(true);
    expect((await runs.getRun(run.id))?.state).toBe("decided");
  });

  it("renewLease extends a held lease so a slow-but-alive run is not reconcilable", async () => {
    const run = await runs.ensureRun(SUBJECT, "poison", "p1");
    const lease = await runs.claimForAnalysis(run.id, "worker-a", 1_000);

    // Almost at expiry, still working: heartbeat renews the lease.
    clock.advance(900);
    expect(await runs.renewLease(run.id, lease!, 1_000)).toBe(true);

    // Past the ORIGINAL expiry but inside the renewed window — not reconcilable.
    clock.advance(200); // now 1_100 since claim, but only 200 since renew
    expect(await runs.findReconcilable(10)).toHaveLength(0);
  });

  it("renewLease with a stale token (after reclaim) fails and cannot resurrect the lease", async () => {
    const run = await runs.ensureRun(SUBJECT, "poison", "p1");
    const leaseA = await runs.claimForAnalysis(run.id, "worker-a", 1_000);

    clock.advance(1_001);
    expect(await runs.reclaimExpired(run.id)).toBe(true); // A's lease expired, reclaimed

    // Zombie A tries to heartbeat with its old token — refused.
    expect(await runs.renewLease(run.id, leaseA!, 1_000)).toBe(false);
    expect((await runs.getRun(run.id))?.state).toBe("pending"); // still reclaimable
  });

  it("a zombie worker cannot overwrite a run that was reclaimed and re-claimed", async () => {
    const run = await runs.ensureRun(SUBJECT, "poison", "p1");
    const leaseA = await runs.claimForAnalysis(run.id, "worker-a", 1_000); // A claims

    // A's lease expires; the reconciler reclaims and worker B re-claims.
    clock.advance(1_001);
    expect(await runs.reclaimExpired(run.id)).toBe(true);
    const leaseB = await runs.claimForAnalysis(run.id, "worker-b", 1_000);
    expect(leaseB).not.toBe(leaseA);

    // Zombie A finally finishes and tries to commit with its stale token — rejected.
    const zombie = await runs.commitDecision({
      runId: run.id,
      from: "analyzing",
      to: "decided",
      reason: "A's stale verdict",
      decision: DECISION,
      findings: [],
      effect: { effectType: "check_run", externalId: "x", payload: {} },
      fenceLease: leaseA!,
    });
    expect(zombie).toBe(false);
    expect((await runs.getRun(run.id))?.state).toBe("analyzing"); // still B's

    // B commits with its own token — lands.
    const bWins = await runs.commitDecision({
      runId: run.id,
      from: "analyzing",
      to: "decided",
      reason: "B's real verdict",
      decision: DECISION,
      findings: [],
      effect: { effectType: "check_run", externalId: "x", payload: {} },
      fenceLease: leaseB!,
    });
    expect(bWins).toBe(true);
    expect((await runs.getRun(run.id))?.state).toBe("decided");
  });
});
