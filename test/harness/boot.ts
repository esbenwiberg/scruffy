import { FixedClock, SeededIdGenerator } from "../../src/platform/clock.js";
import { createPool, type Pool } from "../../src/persistence/db.js";
import { migrate } from "../../src/persistence/migrate.js";
import { Scruffy } from "../../src/app/scruffy.js";
import { FakeScm } from "../../src/providers/scm/fake.js";
import {
  defaultAnalyzers,
  defaultValidator,
  POISON_BLOCKABLE_CLASSES,
  NIGHTLY_REPORTABLE_CLASSES,
  NIGHTLY_FIXABLE_CLASSES,
} from "../../src/providers/registry.js";
import type { EffectivePolicy } from "../../src/domain/policy/types.js";
import { WEBHOOK_SECRET } from "../fixtures/scenarios.js";

/**
 * Boots the whole walking skeleton against real Postgres with fake trust-edge
 * providers, a FixedClock, and a SeededIdGenerator. This is the "spin up Scruffy
 * and run it end to end with seeded data" entry point — one call, real domain
 * code in the middle, deterministic edges.
 */

export const HARNESS_POLICY: EffectivePolicy = {
  version: "policy-v1",
  poison: {
    blockableDefectClasses: [...POISON_BLOCKABLE_CLASSES],
    requireValidation: true,
  },
  nightly: {
    reportableDefectClasses: [...NIGHTLY_REPORTABLE_CLASSES],
    fixableDefectClasses: [...NIGHTLY_FIXABLE_CLASSES],
  },
};

export interface Harness {
  scruffy: Scruffy;
  scm: FakeScm;
  pool: Pool;
  clock: FixedClock;
}

export interface BootOptions {
  leaseMs?: number;
  maxAttempts?: number;
}

export async function bootHarness(options: BootOptions = {}): Promise<Harness> {
  const pool = createPool();
  await migrate(pool);
  // Fresh state each boot: truncate everything the skeleton writes.
  await pool.query(
    "truncate outbox, poison_decisions, nightly_decisions, review_watermarks, run_transitions, evaluation_runs cascade",
  );

  const clock = new FixedClock(new Date("2026-07-15T00:00:00.000Z"));
  const ids = new SeededIdGenerator("harness");
  const scm = new FakeScm();

  const scruffy = new Scruffy({
    pool,
    clock,
    ids,
    policy: HARNESS_POLICY,
    scmReader: scm,
    scmWriter: scm,
    analyzers: defaultAnalyzers(),
    validator: defaultValidator(),
    webhookSecret: WEBHOOK_SECRET,
    ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  });

  return { scruffy, scm, pool, clock };
}
