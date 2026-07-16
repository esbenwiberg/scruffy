import type { RunStore } from "../persistence/runs.js";
import type { EvaluationRun } from "../domain/evaluation/types.js";
import type { PoisonService } from "../gates/poison/service.js";
import type { NightlyService } from "../gates/nightly/service.js";

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
  ) {}

  /** One reconciliation pass. Returns how many runs it acted on. */
  async reconcileOnce(limit = 50): Promise<number> {
    const candidates = await this.runs.findReconcilable(limit);
    let acted = 0;

    for (const run of candidates) {
      // Route by gate: each gate owns its abandonment and drive semantics. A
      // nightly run with no nightly service wired is skipped (never mis-driven
      // through the poison path).
      const maxAttempts = run.kind === "nightly" ? this.nightly?.maxAttempts : this.poison.maxAttempts;
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
    if (run.kind === "nightly") {
      await this.nightly?.abandon(run, "lease expired");
    } else {
      await this.poison.abandon(run, "lease expired");
    }
  }

  async #drive(run: EvaluationRun): Promise<void> {
    if (run.kind === "nightly") {
      await this.nightly?.reconcile(run);
    } else {
      await this.poison.evaluate(run.subject);
    }
  }
}
