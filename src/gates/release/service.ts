import type { EvaluationRun, RunState } from "../../domain/evaluation/types.js";
import type { EffectivePolicy } from "../../domain/policy/types.js";
import type { Validator } from "../../domain/validation/port.js";
import type { Analyzer } from "../../providers/analyzers/port.js";
import type { ScmReader, RevisionRange } from "../../providers/scm/port.js";
import type { RunStore, OutboxEffect } from "../../persistence/runs.js";
import { RELEASE_CHECK_NAME, releaseToCheck, type CheckRunPayload } from "../../effects/check-run.js";
import { runReleaseAnalysis } from "./analyze.js";
import type { ReleaseDecision } from "./decision.js";

export interface ReleaseServiceDeps {
  runs: RunStore;
  scm: ScmReader;
  analyzers: readonly Analyzer[];
  validator: Validator;
  policy: EffectivePolicy;
  /** Lease duration for an analysis claim. Default 60s. */
  leaseMs?: number;
  /** Attempts after which a run is abandoned to indeterminate. Default 3. */
  maxAttempts?: number;
  /** Identifier recorded as the lease owner. Default "release-worker". */
  owner?: string;
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export interface ReleaseInput {
  repository: string;
  /** The release candidate head to review up to (a 40-char sha). */
  candidate: string;
  /**
   * The previous release the range starts from. Null for a first-ever release, in
   * which case the range is the candidate's own full change set.
   */
  prevRelease: string | null;
}

/**
 * Durable release-gate service. Like the poison and nightly services it
 * reconciles a durable run rather than assuming a fresh invocation, so driving it
 * is idempotent and safe from either a release-candidate trigger OR the
 * reconciler.
 *
 * The release gate produces ONE aggregate outcome over the (prev-release,
 * candidate] range. Its terminal states are `decided` (produced a
 * ship / sign-off-required / stop outcome) and `indeterminate` (analysis could
 * not run — abstain). Infra failure never becomes a fabricated ship or stop.
 *
 * Unlike nightly there is no watermark: release is triggered explicitly per
 * candidate with a given previous release, so it evaluates a subject-like unit of
 * work (closer to poison) rather than advancing a per-branch cursor.
 */
export class ReleaseService {
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #owner: string;

  constructor(private readonly deps: ReleaseServiceDeps) {
    this.#leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
    this.#maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#owner = deps.owner ?? "release-worker";
  }

  get maxAttempts(): number {
    return this.#maxAttempts;
  }

  /** Trigger entry point: review the range (prevRelease, candidate] for a repo. */
  async review(input: ReleaseInput): Promise<EvaluationRun> {
    const { runs, policy } = this.deps;
    const run = await runs.ensureReleaseRun(
      { repository: input.repository, commitSha: input.candidate },
      input.prevRelease,
      policy.version,
    );
    return this.#drive(run);
  }

  /** Reconciler entry point: re-drive a reclaimed release run against its frozen range. */
  async reconcile(run: EvaluationRun): Promise<EvaluationRun> {
    return this.#drive(run);
  }

  async #drive(run: EvaluationRun): Promise<EvaluationRun> {
    const { runs } = this.deps;
    if (run.state === "decided" || run.state === "indeterminate" || run.state === "superseded") {
      return run;
    }

    const lease = await runs.claimForAnalysis(run.id, this.#owner, this.#leaseMs);
    if (!lease) return (await runs.getRun(run.id)) ?? run;

    try {
      const range: RevisionRange = {
        repository: run.subject.repository,
        baseSha: run.baseSha,
        headSha: run.subject.commitSha,
      };
      const { findings, decision } = await runReleaseAnalysis(range, {
        scm: this.deps.scm,
        analyzers: this.deps.analyzers,
        validator: this.deps.validator,
        policy: this.deps.policy.release,
      });

      const check = releaseToCheck(decision);
      const payload: CheckRunPayload = {
        subject: run.subject,
        externalId: this.#externalId(run),
        name: RELEASE_CHECK_NAME,
        conclusion: check.conclusion,
        title: check.title,
        summary: check.summary,
      };
      const effect: OutboxEffect = { effectType: "check_run", externalId: payload.externalId, payload };

      await runs.commitReleaseDecision({
        runId: run.id,
        from: "analyzing",
        to: "decided",
        reason: `release ${decision.outcome}`,
        decision,
        findings,
        effect,
        fenceLease: lease,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.#abstain(run, message, { from: "analyzing", fenceLease: lease });
    }

    return (await runs.getRun(run.id)) ?? run;
  }

  /**
   * Give up on a run that has exhausted its attempts: analyzing -> indeterminate
   * with a neutral check. Abstention, never a fabricated ship or stop. Guarded on
   * `analyzing`, so it is a no-op if another worker already reclaimed it.
   */
  async abandon(run: EvaluationRun, reason: string): Promise<void> {
    // Reconciler-driven: transition from the run's OBSERVED state and, when it is
    // analyzing, fence on the lease we saw so we never clobber a worker that
    // reclaimed the run between our read and this write.
    await this.#abstain(run, `abandoned after ${run.attempt} attempts: ${reason}`, {
      from: run.state,
      ...(run.state === "analyzing" && run.leaseId !== null ? { fenceLease: run.leaseId } : {}),
    });
  }

  async #abstain(run: EvaluationRun, message: string, opts: { from: RunState; fenceLease?: string }): Promise<void> {
    const empty: ReleaseDecision = {
      outcome: "indeterminate",
      reasons: [],
      dispositions: [],
      summary: { stopped: 0, escalated: 0, cleared: 0, notRelevant: 0 },
    };
    const payload: CheckRunPayload = {
      subject: run.subject,
      externalId: this.#externalId(run),
      name: RELEASE_CHECK_NAME,
      conclusion: "neutral",
      title: "Release gate: abstained (analysis failed)",
      summary: `Analysis could not complete: ${message}`,
    };
    await this.deps.runs.commitReleaseDecision({
      runId: run.id,
      from: opts.from,
      to: "indeterminate",
      reason: "analysis failed",
      decision: empty,
      findings: [],
      effect: { effectType: "check_run", externalId: payload.externalId, payload },
      ...(opts.fenceLease !== undefined ? { fenceLease: opts.fenceLease } : {}),
    });
  }

  #externalId(run: EvaluationRun): string {
    return `release:${run.subject.repository}:${run.subject.commitSha}`;
  }
}
