import type { RunStore } from "../persistence/runs.js";
import type { PoisonService } from "../gates/poison/service.js";

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
  ) {}

  /** One reconciliation pass. Returns how many runs it acted on. */
  async reconcileOnce(limit = 50): Promise<number> {
    const candidates = await this.runs.findReconcilable(limit);
    let acted = 0;

    for (const run of candidates) {
      if (run.state === "analyzing") {
        // The query only returns analyzing runs with an EXPIRED lease.
        if (run.attempt >= this.poison.maxAttempts) {
          await this.poison.abandon(run, "lease expired");
          acted += 1;
          continue;
        }
        const reclaimed = await this.runs.reclaimExpired(run.id);
        if (!reclaimed) continue; // lost the race to another reconciler
      }

      // Pending (originally, or just reclaimed): drive it through the gate.
      await this.poison.evaluate(run.subject);
      acted += 1;
    }
    return acted;
  }
}
