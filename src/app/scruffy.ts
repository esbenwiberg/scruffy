import type { Clock, IdGenerator } from "../platform/clock.js";
import type { Pool } from "../persistence/db.js";
import { RunStore } from "../persistence/runs.js";
import { OutboxStore } from "../persistence/outbox.js";
import { EffectsDispatcher } from "../effects/dispatcher.js";
import { PoisonService } from "../gates/poison/service.js";
import { NightlyService, type ReviewResult } from "../gates/nightly/service.js";
import { Reconciler } from "./reconciler.js";
import type { EffectivePolicy } from "../domain/policy/types.js";
import { SubjectRevision } from "../domain/evidence/types.js";
import type { Analyzer } from "../providers/analyzers/port.js";
import type { Validator } from "../domain/validation/port.js";
import type { ScmReader, ScmWriter } from "../providers/scm/port.js";
import { verifyAndParseWebhook } from "../ingest/webhook.js";

/**
 * Application wiring. Everything the domain touches is injected, so the harness
 * and tests supply fakes + a FixedClock + a SeededIdGenerator, while production
 * supplies the real GitHub/model/Postgres implementations. Same code path.
 */
export interface ScruffyDeps {
  pool: Pool;
  clock: Clock;
  ids: IdGenerator;
  policy: EffectivePolicy;
  scmReader: ScmReader;
  scmWriter: ScmWriter;
  analyzers: readonly Analyzer[];
  validator: Validator;
  webhookSecret: string;
  /** Optional overrides for the poison analysis lease and retry bound. */
  leaseMs?: number;
  maxAttempts?: number;
}

export class Scruffy {
  readonly runs: RunStore;
  readonly outbox: OutboxStore;
  readonly poison: PoisonService;
  readonly nightly: NightlyService;
  readonly dispatcher: EffectsDispatcher;
  readonly reconciler: Reconciler;

  constructor(private readonly deps: ScruffyDeps) {
    this.runs = new RunStore(deps.pool, deps.clock, deps.ids);
    this.outbox = new OutboxStore(deps.pool, deps.clock);
    this.poison = new PoisonService({
      runs: this.runs,
      scm: deps.scmReader,
      analyzers: deps.analyzers,
      validator: deps.validator,
      policy: deps.policy,
      ...(deps.leaseMs !== undefined ? { leaseMs: deps.leaseMs } : {}),
      ...(deps.maxAttempts !== undefined ? { maxAttempts: deps.maxAttempts } : {}),
    });
    this.nightly = new NightlyService({
      runs: this.runs,
      scm: deps.scmReader,
      analyzers: deps.analyzers,
      validator: deps.validator,
      policy: deps.policy,
      ...(deps.leaseMs !== undefined ? { leaseMs: deps.leaseMs } : {}),
      ...(deps.maxAttempts !== undefined ? { maxAttempts: deps.maxAttempts } : {}),
    });
    this.dispatcher = new EffectsDispatcher(this.outbox, deps.scmWriter);
    this.reconciler = new Reconciler(this.runs, this.poison, this.nightly);
  }

  /** One reconciliation pass; returns runs acted on. */
  async reconcile(limit = 50): Promise<number> {
    return this.reconciler.reconcileOnce(limit);
  }

  /**
   * Full inbound path: verify + parse a webhook, then reconcile the poison run.
   * Returns the evaluation run id when a run was driven.
   */
  async handleWebhook(signature: string, rawBody: string): Promise<{ handled: boolean; runId?: string }> {
    const result = await verifyAndParseWebhook(this.deps.webhookSecret, signature, rawBody);
    if (result.kind === "ignored") return { handled: false };
    const run = await this.poison.evaluate(result.subject);
    return { handled: true, runId: run.id };
  }

  /**
   * Trigger a nightly review of (watermark, head] for a branch. Scheduler-driven,
   * not webhook-driven. Idempotent: re-triggering a head already at the watermark
   * is a no-op. The head is parsed through SubjectRevision so a malformed sha is
   * rejected at the boundary, not deep in the DB.
   */
  async runNightly(input: { repository: string; branch: string; head: string; base?: string | null }): Promise<ReviewResult> {
    const subject = SubjectRevision.parse({ repository: input.repository, commitSha: input.head });
    return this.nightly.review({
      repository: subject.repository,
      branch: input.branch,
      head: subject.commitSha,
      ...(input.base !== undefined ? { base: input.base } : {}),
    });
  }

  /** Drain outbox effects to the SCM writer. Returns count dispatched. */
  async flushEffects(): Promise<number> {
    let total = 0;
    let sent: number;
    do {
      sent = await this.dispatcher.dispatchOnce();
      total += sent;
    } while (sent > 0);
    return total;
  }
}
