import type { EvaluationRun, RunState } from "../../domain/evaluation/types.js";
import type { EffectivePolicy } from "../../domain/policy/types.js";
import type { Validator } from "../../domain/validation/port.js";
import type { Analyzer } from "../../providers/analyzers/port.js";
import type { Fixer } from "../../providers/fixers/port.js";
import type { ScmReader, RevisionRange } from "../../providers/scm/port.js";
import type { NightlyRunStore, OutboxEffect } from "../../persistence/runs.js";
import { NIGHTLY_CHECK_NAME, nightlyToCheck, type CheckRunPayload } from "../../effects/check-run.js";
import type { PullRequestPayload } from "../../effects/pull-request.js";
import { withLeaseHeartbeat } from "../../app/lease-heartbeat.js";
import { runNightlyAnalysis } from "./analyze.js";
import { generateFixes } from "./fix.js";
import type { NightlyDecision } from "./decision.js";
import { abstainedNightlyReport, buildNightlyReport } from "./report.js";
import { planNightlyWorkGraph } from "../../domain/findings/work-graph.js";
import { NIGHTLY_REPORT_SCHEMA_VERSION, type NightlyReportIdentity } from "../../domain/findings/work-identity.js";
import { analysisFailed } from "../../domain/evidence/coverage.js";

export interface NightlyServiceDeps {
  runs: NightlyRunStore;
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

/**
 * Branch recorded when a nightly run somehow has none. The run is a data-invariant
 * violation we abstain on loudly (see `#drive`); the report still needs a
 * non-empty branch so the abstention is durable and visible rather than lost to a
 * schema error on the way out.
 */
const UNKNOWN_BRANCH = "(unknown branch)";

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
 * (produced a report) and `indeterminate` (analysis could not run). Neither one
 * advances the complete-review watermark by itself: the watermark means
 * "completely reviewed through this head", so it moves only for a `decided` run
 * whose report has no required coverage gap. A range reviewed blind stays owed,
 * and a bounded successor attempt may re-review it from the last COMPLETE head.
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

  /**
   * Scheduler entry point: review (complete watermark, head] for a branch. The
   * lower bound is the last head we COMPLETELY reviewed, so an attempt that ended
   * blind never shrinks the next range.
   */
  async review(input: ReviewInput): Promise<ReviewResult> {
    const { runs, policy } = this.deps;
    const base =
      input.base !== undefined ? input.base : ((await runs.getWatermark(input.repository, input.branch))?.lastReviewedHead ?? null);

    // Nothing new since the last COMPLETE review — no run, no effect. Idempotent
    // no-op. Note this is the complete watermark, so a head whose only attempt was
    // incomplete does NOT short-circuit here; it is retried below.
    if (base === input.head) return { reviewed: false, reason: "up-to-date" };

    const run = await runs.ensureNightlyRun(
      { repository: input.repository, commitSha: input.head },
      input.branch,
      base,
      policy.version,
    );
    return { reviewed: true, run: await this.#drive(await this.#reopenIfIncomplete(run)) };
  }

  /**
   * Let a terminal run that did NOT completely review its range be re-reviewed.
   *
   * Without this, a single blind attempt is permanent: the run is terminal so
   * `#drive` returns immediately, while the complete watermark never advanced — so
   * the range would be owed forever and never re-attempted. Bounded by
   * `maxAttempts` (the attempt counter is bumped on each claim), so a persistently
   * failing range escalates to a durable, human-visible coverage gap instead of
   * spinning. A run whose report WAS complete is left alone: re-reviewing a
   * finished range would only re-emit the same effects.
   */
  async #reopenIfIncomplete(run: EvaluationRun): Promise<EvaluationRun> {
    if (run.state !== "decided" && run.state !== "indeterminate") return run;
    if (run.attempt >= this.#maxAttempts) return run;

    // No report at all (a legacy run committed before reports existed, or a run
    // whose commit never landed) counts as NOT completely reviewed. Absence of
    // evidence is not evidence of coverage — the honest move is to re-review.
    const report = await this.deps.runs.latestNightlyReportForRun(run.id);
    if (report !== null && report.requiredCoverageComplete) return run;

    const moved = await this.deps.runs.transition(
      run.id,
      run.state,
      "pending",
      "retry: previous attempt did not completely review the range",
    );
    return moved ? ((await this.deps.runs.getRun(run.id)) ?? run) : run;
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
      const { findings, decision: rawDecision } = await withLeaseHeartbeat(runs, run.id, lease, this.#leaseMs, () =>
        runNightlyAnalysis(range, {
          scm: this.deps.scm,
          analyzers: this.deps.analyzers,
          validator: this.deps.validator,
          policy: this.deps.policy.nightly,
        }),
      );

      // Turn propose_fix dispositions into concrete patches; any that cannot be
      // patched are downgraded to report inside the returned decision.
      const { decision, fixes } = generateFixes(findings, rawDecision, this.deps.fixers);

      // The durable report is built BEFORE any effect payload, so the check, the
      // work graph, and the persisted row are all projections of one value rather
      // than three independent renderings that can disagree.
      const report = buildNightlyReport({ identity: this.#reportIdentity(run, branch), findings, decision, fixes });
      const workGraph = planNightlyWorkGraph(report);

      const check = nightlyToCheck(report);
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
          // The fix targets the branch this nightly review ran on — opening it
          // against the repo default branch would propose the patch to the
          // wrong history whenever nightly reviews a non-default branch.
          baseBranch: branch,
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
        reason:
          `nightly ${report.requiredCoverageComplete ? "completely reviewed" : "PARTIALLY reviewed"} the range: ` +
          `${report.summary.surfaced} surfaced finding(s), ${report.summary.requiredGaps} required coverage gap(s), ${fixes.length} fix PR(s)`,
        report,
        workGraph,
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
    const empty: NightlyDecision = {
      dispositions: [],
      summary: { reported: 0, proposedFixes: 0, suppressed: 0 },
      coverage: analysisFailed(message),
    };
    // An abstention reviewed NOTHING, so its report carries the whole-analysis
    // coverage gap and the planner turns that into durable, human-visible work.
    // A night with no news is exactly the case that must not look like good news.
    const report = abstainedNightlyReport(this.#reportIdentity(run, run.branch ?? UNKNOWN_BRANCH), empty);
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
      report,
      workGraph: planNightlyWorkGraph(report),
      decision: empty,
      findings: [],
      effects: [{ effectType: "check_run", externalId: payload.externalId, payload }],
      ...(opts.fenceLease !== undefined ? { fenceLease: opts.fenceLease } : {}),
    });
  }

  /**
   * The immutable identity of this run's report. Built from the run's FROZEN range
   * (not from a watermark that may have moved) plus the policy version actually
   * applied and the report schema version — so a re-drive of the same run under the
   * same policy lands on the same report, and a policy change is honestly a
   * different report rather than a silent redefinition of an existing one.
   */
  #reportIdentity(run: EvaluationRun, branch: string): NightlyReportIdentity {
    return {
      repository: run.subject.repository,
      branch,
      baseSha: run.baseSha,
      headSha: run.subject.commitSha,
      policyVersion: this.deps.policy.version,
      schemaVersion: NIGHTLY_REPORT_SCHEMA_VERSION,
    };
  }

  #externalId(run: EvaluationRun): string {
    return `nightly:${run.subject.repository}:${run.subject.commitSha}`;
  }
}
