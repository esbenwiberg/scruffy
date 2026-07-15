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

beforeEach(async () => {
  await migrate(pool);
  await pool.query("truncate outbox, poison_decisions, run_transitions, evaluation_runs cascade");
  runs = new RunStore(pool, new FixedClock(new Date("2026-07-15T00:00:00Z")), new SeededIdGenerator("t"));
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
});
