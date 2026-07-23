import type { EvaluationRun, RunState } from "../../domain/evaluation/types.js";
import type { SubjectRevision } from "../../domain/evidence/types.js";
import type { EffectivePolicy } from "../../domain/policy/types.js";
import type { Validator } from "../../domain/validation/port.js";
import type { Analyzer } from "../../providers/analyzers/port.js";
import type { ScmReader } from "../../providers/scm/port.js";
import type { RunStore } from "../../persistence/runs.js";
import { CHECK_NAME, decisionToCheck, type CheckRunPayload } from "../../effects/check-run.js";
import { runPoisonAnalysis } from "./analyze.js";

export interface PoisonServiceDeps {
  runs: RunStore;
  scm: ScmReader;
  analyzers: readonly Analyzer[];
  validator: Validator;
  policy: EffectivePolicy;
  /** Lease duration for an analysis claim. Default 60s. */
  leaseMs?: number;
  /** Attempts after which a run is abandoned to indeterminate. Default 3. */
  maxAttempts?: number;
  /** Identifier recorded as the lease owner. Default "poison-worker". */
  owner?: string;
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Durable poison-gate service. Driving it is idempotent and safe to call from
 * webhook handling OR reconciliation: it reconciles a durable run rather than
 * assuming a fresh invocation.
 *
 *   ensureRun (idempotent)
 *     -> guarded pending->analyzing (claims the work; loses the race safely)
 *     -> analyze + decide
 *     -> atomic terminal transition + decision + outbox effect
 *
 * On analysis failure the run goes to `indeterminate` (abstain) and posts a
 * neutral check. Infra failure never becomes allow or block.
 */
export class PoisonService {
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #owner: string;

  constructor(private readonly deps: PoisonServiceDeps) {
    this.#leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
    this.#maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#owner = deps.owner ?? "poison-worker";
  }

  get maxAttempts(): number {
    return this.#maxAttempts;
  }

  async evaluate(subject: SubjectRevision): Promise<EvaluationRun> {
    const { runs, policy } = this.deps;
    const run = await runs.ensureRun(subject, "poison", policy.version);

    // Already resolved by a prior delivery — nothing to do.
    if (run.state === "decided" || run.state === "indeterminate" || run.state === "superseded") {
      return run;
    }

    const lease = await runs.claimForAnalysis(run.id, this.#owner, this.#leaseMs);
    if (!lease) {
      // Another worker/delivery is handling it (or it already moved). Return latest.
      return (await runs.getRun(run.id)) ?? run;
    }

    try {
      const { findings, decision } = await runPoisonAnalysis(subject, {
        scm: this.deps.scm,
        analyzers: this.deps.analyzers,
        validator: this.deps.validator,
        policy: policy.poison,
      });

      const terminal: RunState = decision.outcome === "indeterminate" ? "indeterminate" : "decided";
      const check = decisionToCheck(decision);
      const payload: CheckRunPayload = {
        subject,
        externalId: `poison:${subject.repository}:${subject.commitSha}`,
        name: CHECK_NAME,
        conclusion: check.conclusion,
        title: check.title,
        summary: this.#summary(decision),
      };

      await runs.commitDecision({
        runId: run.id,
        from: "analyzing",
        to: terminal,
        reason: `poison ${decision.outcome}`,
        decision,
        findings,
        effect: { effectType: "check_run", externalId: payload.externalId, payload },
        fenceLease: lease,
      });
    } catch (err) {
      // Operationally indeterminate: abstain and post a neutral check.
      const message = err instanceof Error ? err.message : String(err);
      const payload: CheckRunPayload = {
        subject,
        externalId: `poison:${subject.repository}:${subject.commitSha}`,
        name: CHECK_NAME,
        conclusion: "neutral",
        title: "Poison gate: abstained (analysis failed)",
        summary: `Analysis could not complete: ${message}`,
      };
      await runs.commitDecision({
        runId: run.id,
        from: "analyzing",
        to: "indeterminate",
        reason: "analysis failed",
        decision: { outcome: "indeterminate", reasons: [], dispositions: [] },
        findings: [],
        effect: { effectType: "check_run", externalId: payload.externalId, payload },
        fenceLease: lease,
      });
    }

    return (await runs.getRun(run.id)) ?? run;
  }

  /**
   * Give up on a run that has exhausted its attempts: -> indeterminate with a
   * neutral check. Abstention, never a fabricated block or allow. Reconciler-only:
   * it transitions from the run's OBSERVED state (analyzing with an expired lease,
   * or pending after a reclaim), guarded so it is a no-op if a worker took over.
   */
  async abandon(run: EvaluationRun, reason: string): Promise<void> {
    const payload: CheckRunPayload = {
      subject: run.subject,
      externalId: `poison:${run.subject.repository}:${run.subject.commitSha}`,
      name: CHECK_NAME,
      conclusion: "neutral",
      title: "Poison gate: abstained (retries exhausted)",
      summary: `Run abandoned after ${run.attempt} attempts: ${reason}`,
    };
    await this.deps.runs.commitDecision({
      runId: run.id,
      from: run.state,
      to: "indeterminate",
      reason: `abandoned: ${reason}`,
      decision: { outcome: "indeterminate", reasons: [], dispositions: [] },
      findings: [],
      effect: { effectType: "check_run", externalId: payload.externalId, payload },
      // Fence on the lease we observed (analyzing only): if another worker reclaimed
      // and re-took the run in the meantime, do not clobber its fresh attempt.
      ...(run.state === "analyzing" && run.leaseId !== null ? { fenceLease: run.leaseId } : {}),
    });
  }

  #summary(decision: { outcome: string; reasons: string[] }): string {
    return `Outcome: ${decision.outcome}. Reasons: ${decision.reasons.join(", ") || "none"}.`;
  }
}
