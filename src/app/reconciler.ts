import type { RunStore } from "../persistence/runs.js";
import type { EvaluationRun } from "../domain/evaluation/types.js";
import type { PoisonService } from "../gates/poison/service.js";
import type { NightlyService } from "../gates/nightly/service.js";
import type { ReleaseService } from "../gates/release/service.js";

/**
 * Durable reconciliation, independent of webhook delivery. It recovers work that
 * would otherwise be lost:
 *
 *  - `pending` runs whose webhook handler died before claiming them;
 *  - `analyzing` runs whose lease expired because the worker crashed
 *    mid-analysis.
 *
 * Crashed runs are reclaimed and re-driven up to a bounded number of attempts;
 * past that they are abandoned to `indeterminate` (abstain), never left stuck
 * and never fabricated into a block/allow. This closes ADR 0003 validation #4.
 *
 * In production this runs on a timer; the reconciler itself is the authority,
 * the webhook is only an optimisation that usually gets there first.
 */
export class Reconciler {
  constructor(
    private readonly runs: RunStore,
    private readonly poison: PoisonService,
    private readonly nightly?: NightlyService,
    private readonly release?: ReleaseService,
  ) {}

  /** Per-gate retry bound; undefined when a gate's service is not wired. */
  #maxAttemptsFor(kind: EvaluationRun["kind"]): number | undefined {
    switch (kind) {
      case "nightly":
        return this.nightly?.maxAttempts;
      case "release":
        return this.release?.maxAttempts;
      case "poison":
        return this.poison.maxAttempts;
      default: {
        const _exhaustive: never = kind;
        return _exhaustive;
      }
    }
  }

  /** One reconciliation pass. Returns how many runs it acted on. */
  async reconcileOnce(limit = 50): Promise<number> {
    const candidates = await this.runs.findReconcilable(limit);
    let acted = 0;

    for (const run of candidates) {
      // Route by gate: each gate owns its abandonment and drive semantics. A run
      // whose gate service is not wired is skipped (never mis-driven through
      // another gate's path).
      const maxAttempts = this.#maxAttemptsFor(run.kind);
      if (maxAttempts === undefined) continue;

      if (run.state === "analyzing") {
        // The query only returns analyzing runs with an EXPIRED lease.
        if (run.attempt >= maxAttempts) {
          await this.#abandon(run);
          acted += 1;
          continue;
        }
        const reclaimed = await this.runs.reclaimExpired(run.id);
        if (!reclaimed) continue; // lost the race to another reconciler
      }

      // Pending (originally, or just reclaimed): drive it through its gate.
      await this.#drive(run);
      acted += 1;
    }
    return acted;
  }

  async #abandon(run: EvaluationRun): Promise<void> {
    switch (run.kind) {
      case "nightly":
        await this.nightly?.abandon(run, "lease expired");
        return;
      case "release":
        await this.release?.abandon(run, "lease expired");
        return;
      case "poison":
        await this.poison.abandon(run, "lease expired");
        return;
      default: {
        const _exhaustive: never = run.kind;
        return _exhaustive;
      }
    }
  }

  async #drive(run: EvaluationRun): Promise<void> {
    switch (run.kind) {
      case "nightly":
        await this.nightly?.reconcile(run);
        return;
      case "release":
        await this.release?.reconcile(run);
        return;
      case "poison":
        await this.poison.evaluate(run.subject);
        return;
      default: {
        const _exhaustive: never = run.kind;
        return _exhaustive;
      }
    }
  }
}
