import { FixedClock, SeededIdGenerator } from "../../src/platform/clock.js";
import { createPool, type Pool } from "../../src/persistence/db.js";
import { migrate } from "../../src/persistence/migrate.js";
import { Scruffy } from "../../src/app/scruffy.js";
import { FakeScm } from "../../src/providers/scm/fake.js";
import {
  defaultAnalyzers,
  defaultValidator,
  defaultFixers,
  POISON_BLOCKABLE_CLASSES,
  NIGHTLY_REPORTABLE_CLASSES,
  NIGHTLY_FIXABLE_CLASSES,
  RELEASE_STOP_CLASSES,
  RELEASE_SIGNOFF_CLASSES,
  DEFAULT_REMEDIATION_POLICY,
} from "../../src/providers/registry.js";
import type { EffectivePolicy } from "../../src/domain/policy/types.js";
import type { ReleaseRiskAnalyst } from "../../src/providers/release-risk/port.js";
import { WEBHOOK_SECRET } from "../fixtures/scenarios.js";

/**
 * Boots the whole walking skeleton against real Postgres with fake trust-edge
 * providers, a FixedClock, and a SeededIdGenerator. This is the "spin up Scruffy
 * and run it end to end with seeded data" entry point — one call, real domain
 * code in the middle, deterministic edges.
 */

/** Exact non-Scruffy CI contexts the harness release policy requires. */
export const HARNESS_REQUIRED_CI_CONTEXTS = ["ci/build", "ci/tests"] as const;

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
  release: {
    stopDefectClasses: [...RELEASE_STOP_CLASSES],
    signoffDefectClasses: [...RELEASE_SIGNOFF_CLASSES],
    // The harness runs no model backend, so the release-risk-llm lane is explicitly
    // not applicable (honest, not a permissive skip). Source analysis and candidate
    // CI are required; the harness seeds honest fake CI evidence to exercise them.
    evidence: {
      "source-analysis": { applicable: true, required: true },
      "release-risk-llm": { applicable: false, required: false },
      "candidate-ci": { applicable: true, required: true, requiredContexts: [...HARNESS_REQUIRED_CI_CONTEXTS] },
    },
  },
  remediation: {
    maxFiles: DEFAULT_REMEDIATION_POLICY.maxFiles,
    maxTotalLines: DEFAULT_REMEDIATION_POLICY.maxTotalLines,
    maxTotalBytes: DEFAULT_REMEDIATION_POLICY.maxTotalBytes,
    protectedPaths: [...DEFAULT_REMEDIATION_POLICY.protectedPaths],
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
  /** Override HARNESS_POLICY — e.g. an all-lanes-required campaign policy. */
  policy?: EffectivePolicy;
  /**
   * Wire a range-level release-risk analyst so the release-risk-llm lane is
   * exercised for real (honest fake evidence, never a bypassed lane). Only opt-in
   * suites that also make the lane applicable/required in `policy` need this.
   */
  releaseRisk?: ReleaseRiskAnalyst;
}

export async function bootHarness(options: BootOptions = {}): Promise<Harness> {
  const pool = createPool();
  await migrate(pool);
  // Fresh state each boot: truncate everything the skeleton writes.
  await pool.query(
    "truncate outbox, poison_decisions, nightly_decisions, release_decisions, release_reports, review_watermarks, run_transitions, evaluation_runs cascade",
  );

  const clock = new FixedClock(new Date("2026-07-15T00:00:00.000Z"));
  const ids = new SeededIdGenerator("harness");
  const scm = new FakeScm();

  const scruffy = new Scruffy({
    pool,
    clock,
    ids,
    policy: options.policy ?? HARNESS_POLICY,
    scmReader: scm,
    scmWriter: scm,
    analyzers: defaultAnalyzers(),
    validator: defaultValidator(),
    fixers: defaultFixers(),
    webhookSecret: WEBHOOK_SECRET,
    ...(options.releaseRisk ? { releaseRisk: options.releaseRisk } : {}),
    ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  });

  return { scruffy, scm, pool, clock };
}
