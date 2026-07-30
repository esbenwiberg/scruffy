import type { Clock, IdGenerator } from "../platform/clock.js";
import type { Pool } from "../persistence/db.js";
import { RunStore } from "../persistence/runs.js";
import { OutboxStore } from "../persistence/outbox.js";
import { PublicationStore } from "../persistence/publications.js";
import { FixLifecycleStore } from "../persistence/fix-lifecycle.js";
import { EffectsDispatcher } from "../effects/dispatcher.js";
import { FixReconciler, type FixReconcileResult } from "./fix-reconciler.js";
import { PatchAppliedVerifier, type PostMergeVerifier } from "../gates/nightly/verify.js";
import { PoisonService } from "../gates/poison/service.js";
import { NightlyService, type ReviewResult } from "../gates/nightly/service.js";
import type { RemediationDeps } from "../gates/nightly/remediation.js";
import { ReleaseService } from "../gates/release/service.js";
import { Reconciler } from "./reconciler.js";
import type { EvaluationRun } from "../domain/evaluation/types.js";
import type { EffectivePolicy } from "../domain/policy/types.js";
import { SubjectRevision } from "../domain/evidence/types.js";
import type { Analyzer } from "../providers/analyzers/port.js";
import type { Validator } from "../domain/validation/port.js";
import type { Fixer } from "../providers/fixers/port.js";
import type { ModelProvider } from "../providers/models/port.js";
import type { ScmLifecycleReader, ScmReader, ScmWriter } from "../providers/scm/port.js";
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
  /** Fixers indexed by defect class, for nightly fix-PR generation. */
  fixers: Record<string, Fixer>;
  /**
   * Absent = no LLM backend configured (`SCRUFFY_MODEL_BACKEND` unset/`fake`
   * upstream of this constructor). Kept OUT of the nightly drive loop in this
   * brief — it is exposed here so a later brief can wire
   * `gates/nightly/remediation.ts`'s `attemptRemediations` into the nightly
   * pipeline via `remediationDeps()` below without touching this interface
   * again.
   */
  model?: ModelProvider;
  /**
   * Read side of the fix lifecycle (PR state, sha-bound CI, branch heads, issue
   * state). Absent = this deployment cannot observe what happens to a fix PR, so
   * `reconcileFixes` is an explicit no-op instead of a loop that silently records
   * nothing. `FakeScm` and the GitHub App lifecycle reader both satisfy it; the
   * gh-cli shadow adapter does not.
   */
  scmLifecycleReader?: ScmLifecycleReader;
  /**
   * How a merged fix is checked against the immutable post-merge candidate.
   * Defaults to the preimage/replacement verifier over `scmReader`; injectable so
   * a later brief can add an adversarial verifier without changing this wiring.
   */
  postMergeVerifier?: PostMergeVerifier;
  webhookSecret: string;
  /** Optional overrides for the poison analysis lease and retry bound. */
  leaseMs?: number;
  maxAttempts?: number;
}

export class Scruffy {
  readonly runs: RunStore;
  readonly outbox: OutboxStore;
  readonly publications: PublicationStore;
  readonly fixes: FixLifecycleStore;
  readonly poison: PoisonService;
  readonly nightly: NightlyService;
  readonly release: ReleaseService;
  readonly dispatcher: EffectsDispatcher;
  readonly reconciler: Reconciler;
  /** Null when no lifecycle reader was supplied — see `ScruffyDeps.scmLifecycleReader`. */
  readonly fixReconciler: FixReconciler | null;

  constructor(private readonly deps: ScruffyDeps) {
    this.runs = new RunStore(deps.pool, deps.clock, deps.ids);
    this.outbox = new OutboxStore(deps.pool, deps.clock);
    this.publications = new PublicationStore(deps.pool, deps.clock);
    this.fixes = new FixLifecycleStore(deps.pool, deps.clock);
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
      fixers: deps.fixers,
      policy: deps.policy,
      ...(deps.leaseMs !== undefined ? { leaseMs: deps.leaseMs } : {}),
      ...(deps.maxAttempts !== undefined ? { maxAttempts: deps.maxAttempts } : {}),
    });
    this.release = new ReleaseService({
      runs: this.runs,
      scm: deps.scmReader,
      analyzers: deps.analyzers,
      validator: deps.validator,
      policy: deps.policy,
      ...(deps.leaseMs !== undefined ? { leaseMs: deps.leaseMs } : {}),
      ...(deps.maxAttempts !== undefined ? { maxAttempts: deps.maxAttempts } : {}),
    });
    this.dispatcher = new EffectsDispatcher(this.outbox, deps.scmWriter, this.publications, this.fixes);
    this.reconciler = new Reconciler(this.runs, this.poison, this.nightly, this.release);
    this.fixReconciler =
      deps.scmLifecycleReader === undefined
        ? null
        : new FixReconciler({
            lifecycle: this.fixes,
            reader: deps.scmLifecycleReader,
            writer: deps.scmWriter,
            verifier: deps.postMergeVerifier ?? new PatchAppliedVerifier(deps.scmReader),
            clock: deps.clock,
          });
  }

  /** One reconciliation pass; returns runs acted on. */
  async reconcile(limit = 50): Promise<number> {
    return this.reconciler.reconcileOnce(limit);
  }

  /**
   * One fix-lifecycle pass: observe delivered PRs (state, sha-bound CI, merge),
   * verify merged remediation against the immutable post-merge head, fold in human
   * dismissals, and close parents whose children are all terminal. Writes nothing
   * to code and never merges.
   *
   * Returns all-zero counts when no lifecycle reader is wired, so a caller can run
   * this unconditionally in the engine loop.
   */
  async reconcileFixes(): Promise<FixReconcileResult> {
    if (this.fixReconciler === null) {
      return { proposalsObserved: 0, verificationsRecorded: 0, dismissalsRecorded: 0, resolutionsChanged: 0, parentsClosed: 0 };
    }
    return this.fixReconciler.reconcile();
  }

  /**
   * Assembles `gates/nightly/remediation.ts`'s `RemediationDeps` from this
   * instance's own wiring, so a caller (a later brief's service code, or a
   * script) never has to re-derive fixers/model/scmReader/policy by hand.
   * `model` is undefined whenever no LLM backend was configured — the
   * remediation boundary treats that as "unavailable", never a silent
   * "no fix needed" (see `attemptRemediation`'s `no_fixer_no_model` reason).
   */
  remediationDeps(): RemediationDeps {
    return {
      fixers: this.deps.fixers,
      ...(this.deps.model !== undefined ? { model: this.deps.model } : {}),
      scmReader: this.deps.scmReader,
      policy: this.deps.policy.remediation,
    };
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
   * Verify + parse a webhook and durably record the poison run WITHOUT driving
   * it. This is the fast-ack half for an HTTP server working inside GitHub's
   * ~10s delivery budget: the run is durable BEFORE the 202 goes out, so a crash
   * between ack and analysis loses nothing — the reconciler finds the `pending`
   * run and drives it (the webhook is a prompt; the reconciler is the authority).
   */
  async acceptWebhook(
    signature: string,
    rawBody: string,
  ): Promise<{ accepted: false; reason: string } | { accepted: true; runId: string; subject: SubjectRevision }> {
    const result = await verifyAndParseWebhook(this.deps.webhookSecret, signature, rawBody);
    if (result.kind === "ignored") return { accepted: false, reason: result.reason };
    const run = await this.runs.ensureRun(result.subject, "poison", this.deps.policy.version);
    return { accepted: true, runId: run.id, subject: result.subject };
  }

  /**
   * Trigger a nightly review of (watermark, head] for a branch. Scheduler-driven,
   * not webhook-driven. Idempotent: re-triggering a head already at the watermark
   * is a no-op. The head is parsed through SubjectRevision so a malformed sha is
   * rejected at the boundary, not deep in the DB.
   */
  async runNightly(input: { repository: string; branch: string; head: string; base?: string | null }): Promise<ReviewResult> {
    const subject = SubjectRevision.parse({ repository: input.repository, commitSha: input.head });
    // Parse `base` at the boundary like runRelease does for prevRelease, so a
    // malformed base is rejected here with a clear SubjectRevision error rather
    // than deep in persistence. Preserve the undefined/null distinction the
    // nightly review relies on: undefined => use the watermark; null => explicit
    // first-ever base; a sha => validated override.
    const base =
      input.base == null ? input.base : SubjectRevision.parse({ repository: input.repository, commitSha: input.base }).commitSha;
    return this.nightly.review({
      repository: subject.repository,
      branch: input.branch,
      head: subject.commitSha,
      ...(base !== undefined ? { base } : {}),
    });
  }

  /**
   * Trigger a release review of the range (prevRelease, candidate] for a repo.
   * Trigger-driven (a controlled draft-release protocol later), not webhook-driven.
   * Idempotent: re-triggering the same candidate reconciles the existing run. The
   * candidate and prev-release shas are parsed at the boundary so a malformed sha
   * is rejected here, not deep in the DB.
   */
  async runRelease(input: { repository: string; candidate: string; prevRelease?: string | null }): Promise<EvaluationRun> {
    const subject = SubjectRevision.parse({ repository: input.repository, commitSha: input.candidate });
    const prevRelease =
      input.prevRelease == null ? null : SubjectRevision.parse({ repository: input.repository, commitSha: input.prevRelease }).commitSha;
    return this.release.review({
      repository: subject.repository,
      candidate: subject.commitSha,
      prevRelease,
    });
  }

  /**
   * Drain outbox effects to the SCM writer. Returns count dispatched.
   *
   * Bounded by `maxPasses` so a poison-pill effect that a batch keeps re-counting
   * without draining, or a continuously-refilled outbox, can never hot-spin or
   * block the caller indefinitely in a single flush. Whatever remains pending is
   * picked up by the next flush/reconcile pass.
   */
  async flushEffects(maxPasses = 100): Promise<number> {
    let total = 0;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const sent = await this.dispatcher.dispatchOnce();
      if (sent === 0) break;
      total += sent;
    }
    return total;
  }
}
