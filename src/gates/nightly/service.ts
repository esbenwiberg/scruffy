import type { EvaluationRun, RunState } from "../../domain/evaluation/types.js";
import type { Finding } from "../../domain/evidence/types.js";
import type { EffectivePolicy } from "../../domain/policy/types.js";
import type { Validator } from "../../domain/validation/port.js";
import type { Analyzer } from "../../providers/analyzers/port.js";
import type { Fixer } from "../../providers/fixers/port.js";
import type { ModelProvider } from "../../providers/models/port.js";
import type { ScmReader, RevisionRange } from "../../providers/scm/port.js";
import type { NightlyRunStore, OutboxEffect } from "../../persistence/runs.js";
import { NIGHTLY_CHECK_NAME, nightlyCheckExternalId, nightlyToCheck, type CheckRunPayload } from "../../effects/check-run.js";
import { planIssuePublicationEffects } from "../../effects/publication-plan.js";
import { withLeaseHeartbeat } from "../../app/lease-heartbeat.js";
import { findingKey } from "../../domain/findings/identity.js";
import { runNightlyAnalysis } from "./analyze.js";
import { planFixDeliveryEffects } from "./fix-delivery.js";
import { attemptRemediations, type RemediationAttempt } from "./remediation.js";
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
  /** Deterministic fixers indexed by defect class. Always preferred over the model. */
  fixers: Record<string, Fixer>;
  /**
   * LLM remediation backend. Absent = no model configured, in which case a finding
   * with no deterministic fixer records remediation `unavailable` with a stated
   * reason. A missing model must never read as "no fix was needed".
   */
  model?: ModelProvider;
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
      const { findings, decision } = await withLeaseHeartbeat(runs, run.id, lease, this.#leaseMs, () =>
        runNightlyAnalysis(range, {
          scm: this.deps.scm,
          analyzers: this.deps.analyzers,
          validator: this.deps.validator,
          policy: this.deps.policy.nightly,
        }),
      );

      // EVERY surviving finding earns one remediation attempt — deterministic where
      // a fixer is registered, the model otherwise. Note the disposition axis is no
      // longer rewritten by the outcome: a finding whose patch could not be produced
      // is still exactly as real as it was, it just carries an honest remediation
      // state. Heartbeated separately because model calls are the slow part.
      const attempts = await withLeaseHeartbeat(runs, run.id, lease, this.#leaseMs, () =>
        this.#attemptRemediations(findings, decision),
      );

      // The durable report is built BEFORE any effect payload, so the check, the
      // work graph, and the persisted row are all projections of one value rather
      // than three independent renderings that can disagree.
      const report = buildNightlyReport({ identity: this.#reportIdentity(run, branch), findings, decision, attempts });
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
      // Publish the durable work graph as a parent issue with native child issues,
      // then deliver each proposal as a PR linked to its child issue. The gate only
      // ENQUEUES: every GitHub call happens in the effects component, behind the
      // separate write credential. A complete, clean run plans nothing at all.
      effects.push(...planIssuePublicationEffects({ report, workGraph, check: checkPayload }));
      effects.push(...planFixDeliveryEffects({ report, workGraph }));

      await runs.commitNightlyDecision({
        runId: run.id,
        from: "analyzing",
        to: "decided",
        reason:
          `nightly ${report.requiredCoverageComplete ? "completely reviewed" : "PARTIALLY reviewed"} the range: ` +
          `${report.summary.surfaced} surfaced finding(s), ${report.summary.requiredGaps} required coverage gap(s), ${report.summary.proposals} fix proposal(s)`,
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
   * Attempt remediation for exactly the findings a human will be shown.
   *
   * SUPPRESSED FINDINGS ARE SKIPPED, and that is a cost decision as much as a
   * correctness one: a suppressed finding produces no work item and no PR, so
   * spending a model call on it would buy nothing. Everything else — validated or
   * not, deterministically supported or not, "fixable class" or not — gets an
   * attempt, because deciding in advance that a finding is unfixable is exactly
   * the coupling this series set out to remove.
   */
  async #attemptRemediations(
    findings: readonly Finding[],
    decision: NightlyDecision,
  ): Promise<Map<string, RemediationAttempt>> {
    const surfaced = new Set(decision.dispositions.filter((d) => d.disposition !== "suppress").map((d) => d.findingKey));
    const targets = findings.filter((f) => surfaced.has(findingKey(f)));
    if (targets.length === 0) return new Map();
    return attemptRemediations(targets, {
      fixers: this.deps.fixers,
      ...(this.deps.model !== undefined ? { model: this.deps.model } : {}),
      scmReader: this.deps.scm,
      policy: this.deps.policy.remediation,
    });
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
    const workGraph = planNightlyWorkGraph(report);
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
      workGraph,
      decision: empty,
      findings: [],
      effects: [
        { effectType: "check_run", externalId: payload.externalId, payload },
        // An abstention reviewed nothing, so its coverage gap is durable human work
        // that must reach a human as an issue. A silent abstention is the failure
        // mode this whole slice exists to prevent.
        ...planIssuePublicationEffects({ report, workGraph, check: payload }),
      ],
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
    return nightlyCheckExternalId(run.subject.repository, run.subject.commitSha);
  }
}
