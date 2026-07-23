import type { EvaluationRun, RunState } from "../../domain/evaluation/types.js";
import type { EffectivePolicy } from "../../domain/policy/types.js";
import type { Validator } from "../../domain/validation/port.js";
import type { Analyzer } from "../../providers/analyzers/port.js";
import type { Fixer } from "../../providers/fixers/port.js";
import type { ScmReader, RevisionRange } from "../../providers/scm/port.js";
import type { RunStore, OutboxEffect } from "../../persistence/runs.js";
import { NIGHTLY_CHECK_NAME, nightlyToCheck, type CheckRunPayload } from "../../effects/check-run.js";
import type { PullRequestPayload } from "../../effects/pull-request.js";
import { runNightlyAnalysis } from "./analyze.js";
import { generateFixes } from "./fix.js";
import type { NightlyDecision } from "./decision.js";

export interface NightlyServiceDeps {
  runs: RunStore;
  scm: ScmReader;
  analyzers: readonly Analyzer[];
  validator: Validator;
  /** Fixers indexed by defect class, for propose_fix -> fix-PR generation. */
  fixers: Record<string, Fixer>;
  policy: EffectivePolicy;
  /** Lease duration for an analysis claim. Default 60s. */
  leaseMs?: number;
  /** Attempts after which a run is abandoned to indeterminate. Default 3. */
  maxAttempts?: number;
  /** Identifier recorded as the lease owner. Default "nightly-worker". */
  owner?: string;
}

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export interface ReviewInput {
  repository: string;
  branch: string;
  /** Range head to review up to (a 40-char sha). */
  head: string;
  /**
   * Explicit base override. When omitted the base is the branch's current
   * watermark (null for a first-ever review). Provided mainly for tests and
   * backfills.
   */
  base?: string | null;
}

export type ReviewResult =
  | { reviewed: true; run: EvaluationRun }
  | { reviewed: false; reason: "up-to-date" };

/**
 * Durable nightly-gate service. Like the poison service it reconciles a durable
 * run rather than assuming a fresh invocation, and driving it is idempotent and
 * safe from either a scheduler trigger OR the reconciler.
 *
 * The nightly gate never blocks — it proposes. Its terminal states are `decided`
 * (produced dispositions; watermark advances) and `indeterminate` (analysis could
 * not run; watermark stays put so the range is re-reviewed later).
 */
export class NightlyService {
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #owner: string;

  constructor(private readonly deps: NightlyServiceDeps) {
    this.#leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
    this.#maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#owner = deps.owner ?? "nightly-worker";
  }

  get maxAttempts(): number {
    return this.#maxAttempts;
  }

  /** Scheduler entry point: review (watermark, head] for a branch. */
  async review(input: ReviewInput): Promise<ReviewResult> {
    const { runs, policy } = this.deps;
    const base =
      input.base !== undefined ? input.base : ((await runs.getWatermark(input.repository, input.branch))?.lastReviewedHead ?? null);

    // Nothing new since the last review — no run, no effect. Idempotent no-op.
    if (base === input.head) return { reviewed: false, reason: "up-to-date" };

    const run = await runs.ensureNightlyRun(
      { repository: input.repository, commitSha: input.head },
      input.branch,
      base,
      policy.version,
    );
    return { reviewed: true, run: await this.#drive(run) };
  }

  /** Reconciler entry point: re-drive a reclaimed nightly run against its frozen range. */
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

    const branch = run.branch;
    if (branch === null) {
      // Data invariant: a nightly run always carries its branch. Abstain loudly.
      await this.#abstain(run, "nightly run missing branch", { from: "analyzing", fenceLease: lease });
      return (await runs.getRun(run.id)) ?? run;
    }

    try {
      const range: RevisionRange = {
        repository: run.subject.repository,
        baseSha: run.baseSha,
        headSha: run.subject.commitSha,
      };
      const { findings, decision: rawDecision } = await runNightlyAnalysis(range, {
        scm: this.deps.scm,
        analyzers: this.deps.analyzers,
        validator: this.deps.validator,
        policy: this.deps.policy.nightly,
      });

      // Turn propose_fix dispositions into concrete patches; any that cannot be
      // patched are downgraded to report inside the returned decision.
      const { decision, fixes } = generateFixes(findings, rawDecision, this.deps.fixers);

      const check = nightlyToCheck(decision);
      const checkPayload: CheckRunPayload = {
        subject: run.subject,
        externalId: this.#externalId(run),
        name: NIGHTLY_CHECK_NAME,
        conclusion: check.conclusion,
        title: check.title,
        summary: check.summary,
      };
      const effects: OutboxEffect[] = [
        { effectType: "check_run", externalId: checkPayload.externalId, payload: checkPayload },
      ];
      for (const fix of fixes) {
        const prPayload: PullRequestPayload = {
          subject: fix.subject,
          externalId: fix.branch,
          branch: fix.branch,
          title: fix.title,
          body: fix.body,
          edits: fix.edits,
        };
        effects.push({ effectType: "pull_request", externalId: fix.branch, payload: prPayload });
      }

      await runs.commitNightlyDecision({
        runId: run.id,
        from: "analyzing",
        to: "decided",
        reason: `nightly reviewed ${decision.summary.reported + decision.summary.proposedFixes} finding(s), ${fixes.length} fix PR(s)`,
        repository: run.subject.repository,
        branch,
        baseSha: run.baseSha,
        headSha: run.subject.commitSha,
        decision,
        findings,
        effects,
        fenceLease: lease,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.#abstain(run, message, { from: "analyzing", fenceLease: lease });
    }

    return (await runs.getRun(run.id)) ?? run;
  }

  /**
   * Give up on a nightly run: analyzing -> indeterminate with a neutral report.
   * The watermark does NOT advance, so the range is re-reviewed on a later pass.
   * Guarded on `analyzing`, so it is a no-op if another worker already moved it.
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
    const empty: NightlyDecision = { dispositions: [], summary: { reported: 0, proposedFixes: 0, suppressed: 0 } };
    const payload: CheckRunPayload = {
      subject: run.subject,
      externalId: this.#externalId(run),
      name: NIGHTLY_CHECK_NAME,
      conclusion: "neutral",
      title: "Nightly review: abstained (analysis failed)",
      summary: `Analysis could not complete: ${message}`,
    };
    await this.deps.runs.commitNightlyDecision({
      runId: run.id,
      from: opts.from,
      to: "indeterminate",
      reason: "analysis failed",
      repository: run.subject.repository,
      branch: run.branch ?? "",
      baseSha: run.baseSha,
      headSha: run.subject.commitSha,
      decision: empty,
      findings: [],
      effects: [{ effectType: "check_run", externalId: payload.externalId, payload }],
      ...(opts.fenceLease !== undefined ? { fenceLease: opts.fenceLease } : {}),
    });
  }

  #externalId(run: EvaluationRun): string {
    return `nightly:${run.subject.repository}:${run.subject.commitSha}`;
  }
}
