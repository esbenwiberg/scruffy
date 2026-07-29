import type { EffectProduction } from "../domain/findings/work-publication.js";
import { fixWorkItemsSection } from "../domain/fixes/delivery.js";
import type { NightlyFixLifecyclePort } from "../persistence/fix-lifecycle.js";
import type { OutboxPort, OutboxRecord } from "../persistence/outbox.js";
import type { NightlyPublicationPort } from "../persistence/publications.js";
import type { IssueRef, ScmWriter } from "../providers/scm/port.js";
import { CheckRunPayload, toCheckRunInput } from "./check-run.js";
import {
  NIGHTLY_CHECK_REFRESH_EFFECT,
  NIGHTLY_ISSUE_EFFECT,
  NIGHTLY_ISSUE_LINK_EFFECT,
  NIGHTLY_ISSUE_SUMMARY_EFFECT,
  NightlyCheckRefreshPayload,
  NightlyIssueLinkPayload,
  NightlyIssuePayload,
  NightlyIssueSummaryPayload,
  checkSummaryWithPublication,
  publicationSection,
  toIssueUpsertInput,
  withParentLink,
} from "./issues.js";
import { PullRequestPayload, toPullRequestInput } from "./pull-request.js";

/**
 * The effects component. It is the only path that performs SCM writes (ADR
 * 0001/0003). It drains the outbox and applies each effect idempotently:
 *
 *  - the SCM upsert is keyed by (subject, externalId) for checks, by the head
 *    branch for PRs, and by the hidden marker for issues, so re-dispatching the
 *    same effect does not create a duplicate;
 *  - only after the write succeeds is the row marked `sent`, so a crash between
 *    write and mark simply re-dispatches (at-least-once + idempotent = safe).
 *
 * ERROR ISOLATION (load-bearing): each record is applied in its own try/catch.
 * A record that throws — a wedged network, or an adapter that refuses a write —
 * must never abort the batch, or a single poison-pill effect at the front of the
 * queue (claimPending orders by created_at) would permanently starve every
 * effect behind it. So a throw is contained to that one record.
 *
 *  - a PERMANENT failure (unknown effect type / unparseable payload) can never
 *    succeed on retry, so it is dead-lettered immediately;
 *  - a TRANSIENT failure (SCM write threw) is left pending and retried, up to
 *    MAX_ATTEMPTS, after which it too is dead-lettered so it stops looping
 *    unnoticed. Nothing is ever silently dropped — a dead letter records why.
 *
 * DEPENDENT EFFECTS. Issue publication is a graph: a child needs the parent's
 * number, an attachment needs both, and the reconciliation effects need every child
 * settled. Those edges are declared in the outbox and enforced by its CLAIM query,
 * so a dependent effect is never claimed — and therefore never delivered and never
 * marked sent — before its references exist. The dispatcher's own job on the
 * dependency front is the other half: when it dead-letters an effect that was
 * supposed to PRODUCE a reference, it records that terminal failure against the work
 * item (making it visible on the durable report and the check) and cascades it to
 * whatever was waiting, so nothing waits forever on a reference that will never come.
 */

/** Retry budget for a transient write failure before the effect is dead-lettered. */
const MAX_ATTEMPTS = 5;

type ApplyResult = { kind: "sent" } | { kind: "permanent"; reason: string } | { kind: "transient"; reason: string };

export class EffectsDispatcher {
  constructor(
    private readonly outbox: OutboxPort,
    private readonly scm: ScmWriter,
    /**
     * Durable publication state. Optional so a deployment that publishes only
     * checks/PRs needs no extra wiring; without it an issue effect is dead-lettered
     * with an honest reason rather than silently dropped or falsely marked sent.
     */
    private readonly publications?: NightlyPublicationPort,
    /**
     * Durable fix-delivery state. Optional for the same reason as `publications`;
     * without it a fix PR is still opened, but its number/url/head sha are not
     * persisted, so nothing can reconcile CI, merge, or verification. A deployment
     * that wants the lifecycle wires this.
     */
    private readonly fixLifecycle?: NightlyFixLifecyclePort,
  ) {}

  /** Dispatch one batch. Returns the number of effects successfully sent. */
  async dispatchOnce(batch = 20): Promise<number> {
    const claimed = await this.outbox.claimPending(batch);
    let sent = 0;
    for (const record of claimed) {
      // The whole per-record body — including the markSent/markFailed store
      // writes — is contained here. #apply never throws, but a mark* call can
      // (a DB blip), and letting that reject dispatchOnce would abort the batch
      // and starve the records behind it: exactly the shape error isolation
      // exists to prevent. A failed mark leaves the row pending/claimed, so it
      // is re-processed on a later pass (writes are idempotent).
      try {
        const result = await this.#apply(record);
        if (result.kind === "sent") {
          await this.outbox.markSent(record.id);
          sent += 1;
        } else if (result.kind === "permanent") {
          console.error(`outbox ${record.id}: permanent failure — dead-lettering: ${result.reason}`);
          await this.outbox.markFailed(record.id, result.reason);
          await this.#recordTerminalFailure(record, result.reason);
        } else if (record.attempts >= MAX_ATTEMPTS) {
          console.error(`outbox ${record.id}: ${record.attempts} attempts exhausted — dead-lettering: ${result.reason}`);
          await this.outbox.markFailed(record.id, result.reason);
          await this.#recordTerminalFailure(record, result.reason);
        } else {
          // Transient with budget left: release the claim back to `pending` so it
          // is re-claimed and retried on the next pass. Without the release the
          // row would stay in `processing` and only come back after its lease
          // expired — losing the immediate next-pass retry cadence.
          console.error(`outbox ${record.id}: transient failure (attempt ${record.attempts}), will retry: ${result.reason}`);
          await this.outbox.release(record.id);
        }
      } catch (err) {
        // A store write (mark*/release) threw. Contain it to this record so the
        // rest of the batch still runs; the row stays in `processing` and is
        // reclaimed once its lease expires (delivery is idempotent, so re-running
        // it is safe).
        console.error(`outbox ${record.id}: mark failed, leaving for retry: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return sent;
  }

  /** Apply one effect. Never throws — a failure is returned as a typed result. */
  async #apply(record: OutboxRecord): Promise<ApplyResult> {
    try {
      return await this.#dispatch(record);
    } catch (err) {
      // The issue handlers READ durable publication state before writing (a child
      // needs its parent's number). A store blip on that read must be a retryable
      // transient like any other, not an escape that strands the claim in
      // `processing` until its lease expires.
      return { kind: "transient", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async #dispatch(record: OutboxRecord): Promise<ApplyResult> {
    switch (record.effectType) {
      case "check_run": {
        const parsed = CheckRunPayload.safeParse(record.payload);
        if (!parsed.success) return { kind: "permanent", reason: `invalid check_run payload: ${parsed.error.message}` };
        return this.#write(() => this.scm.upsertCheckRun(toCheckRunInput(parsed.data)));
      }
      case "pull_request": {
        const parsed = PullRequestPayload.safeParse(record.payload);
        if (!parsed.success) return { kind: "permanent", reason: `invalid pull_request payload: ${parsed.error.message}` };
        return this.#deliverPullRequest(parsed.data);
      }
      case NIGHTLY_ISSUE_EFFECT: {
        const parsed = NightlyIssuePayload.safeParse(record.payload);
        if (!parsed.success) return { kind: "permanent", reason: `invalid ${NIGHTLY_ISSUE_EFFECT} payload: ${parsed.error.message}` };
        return this.#publishIssue(parsed.data);
      }
      case NIGHTLY_ISSUE_LINK_EFFECT: {
        const parsed = NightlyIssueLinkPayload.safeParse(record.payload);
        if (!parsed.success) return { kind: "permanent", reason: `invalid ${NIGHTLY_ISSUE_LINK_EFFECT} payload: ${parsed.error.message}` };
        return this.#linkIssue(parsed.data);
      }
      case NIGHTLY_ISSUE_SUMMARY_EFFECT: {
        const parsed = NightlyIssueSummaryPayload.safeParse(record.payload);
        if (!parsed.success) {
          return { kind: "permanent", reason: `invalid ${NIGHTLY_ISSUE_SUMMARY_EFFECT} payload: ${parsed.error.message}` };
        }
        return this.#summarizeParentIssue(parsed.data);
      }
      case NIGHTLY_CHECK_REFRESH_EFFECT: {
        const parsed = NightlyCheckRefreshPayload.safeParse(record.payload);
        if (!parsed.success) {
          return { kind: "permanent", reason: `invalid ${NIGHTLY_CHECK_REFRESH_EFFECT} payload: ${parsed.error.message}` };
        }
        return this.#refreshCheck(parsed.data);
      }
      default:
        return { kind: "permanent", reason: `unknown effect type ${record.effectType}` };
    }
  }

  /**
   * Open (or match) the fix PR, then STORE the provider's answer.
   *
   * Persisting the result is the whole point: the previous implementation
   * discarded it, so a `delivery = 'ready_open'` row named no pull request and
   * nothing downstream could read its CI, its merge, or its head sha. The stored
   * head sha is what binds every later CI verdict to a commit.
   *
   * The body is completed here rather than at plan time. When the effect was
   * enqueued the child issue did not exist — the PR effect DEPENDS on that
   * reference, so by the time it is claimed the reference is on record and the PR
   * a human opens links straight to the finding issue and the nightly run issue.
   *
   * `draft` comes back from the provider, not from what we asked for: if a
   * repository refuses drafts, an "unconfirmed" patch that opened ready for review
   * must be recorded as ready, not as the draft we intended.
   */
  async #deliverPullRequest(payload: PullRequestPayload): Promise<ApplyResult> {
    const input = toPullRequestInput(payload);
    const child = await this.#issueRef(payload.workItemId);
    const parent = await this.#issueRef(payload.parentWorkItemId);
    const links = fixWorkItemsSection(child, parent);

    return this.#write(async () => {
      const result = await this.scm.openPullRequest({
        ...input,
        body: links === null ? input.body : `${input.body}\n\n${links}`,
        ...(child !== null ? { childIssue: child } : {}),
      });
      if (payload.proposalId === undefined || !this.fixLifecycle) return;
      await this.fixLifecycle.recordDeliveryResult({
        proposalId: payload.proposalId,
        delivery: result.draft ? "draft_open" : "ready_open",
        pr: { number: result.number, url: result.url, headSha: result.headSha, draft: result.draft },
      });
    });
  }

  /** A published issue reference for a work item, in provider-port shape, or null. */
  async #issueRef(workItemId: string | null | undefined): Promise<IssueRef | null> {
    if (workItemId === undefined || workItemId === null || !this.publications) return null;
    const ref = await this.publications.getIssueRef(workItemId);
    return ref === null ? null : { number: ref.number, id: ref.externalId, url: ref.url };
  }

  /**
   * Create or update one work item's issue, then STORE the reference. The store
   * write is what makes the next effect in the graph possible, and losing it is the
   * crash the marker lookup exists to recover from: if the process dies between the
   * GitHub write and this line, the retry's marker lookup finds the same issue and
   * records it, rather than opening a duplicate.
   */
  async #publishIssue(payload: NightlyIssuePayload): Promise<ApplyResult> {
    const publications = this.publications;
    if (!publications) return unconfigured(NIGHTLY_ISSUE_EFFECT);

    let parentRef = null;
    if (payload.parentWorkItemId !== null) {
      parentRef = await publications.getIssueRef(payload.parentWorkItemId);
      if (parentRef === null) {
        // Belt and braces: the claim query should never hand us a child whose parent
        // is unpublished. If it somehow does, the honest answer is "not yet" — a
        // retryable transient, NEVER a sent effect with a parentless child issue.
        return { kind: "transient", reason: `parent work item ${payload.parentWorkItemId} has no issue reference yet` };
      }
    }

    // What we already know about THIS work item's issue. Present on every
    // re-dispatch, absent on the first attempt and after the crash the marker
    // lookup exists to recover from — which is exactly when the adapter needs to go
    // looking rather than trust us.
    const knownRef = await publications.getIssueRef(payload.workItemId);

    return this.#write(async () => {
      const result = await this.scm.upsertIssue(
        toIssueUpsertInput(payload, withParentLink(payload.body, parentRef), knownRef),
      );
      await publications.recordIssue(payload.workItemId, payload.marker, {
        provider: "github",
        number: result.number,
        externalId: result.id,
        url: result.url,
      });
    });
  }

  /** Attach a child under its parent using the provider's native hierarchy. */
  async #linkIssue(payload: NightlyIssueLinkPayload): Promise<ApplyResult> {
    const publications = this.publications;
    if (!publications) return unconfigured(NIGHTLY_ISSUE_LINK_EFFECT);

    const parent = await publications.getIssueRef(payload.parentWorkItemId);
    const child = await publications.getIssueRef(payload.childWorkItemId);
    if (parent === null || child === null) {
      return {
        kind: "transient",
        reason: `attachment needs both issue references (parent: ${parent !== null}, child: ${child !== null})`,
      };
    }

    return this.#write(async () => {
      await this.scm.linkChildIssue({
        repository: payload.repository,
        parent: { number: parent.number, id: parent.externalId, url: parent.url },
        child: { number: child.number, id: child.externalId, url: child.url },
      });
      await publications.recordAttachment(payload.childWorkItemId);
    });
  }

  /**
   * Rewrite the parent issue body with the publication status of its children — the
   * only place a human sees "one of these findings could not be filed". Rendered
   * from persisted state, so it reports what actually happened rather than what was
   * planned.
   */
  async #summarizeParentIssue(payload: NightlyIssueSummaryPayload): Promise<ApplyResult> {
    const publications = this.publications;
    if (!publications) return unconfigured(NIGHTLY_ISSUE_SUMMARY_EFFECT);

    const state = await publications.publicationState(payload.reportId);
    if (state === null || state.parent === null) {
      // The work items are gone (report deleted) — nothing to reconcile, and no
      // retry can bring them back.
      return { kind: "permanent", reason: `no work graph on record for report ${payload.reportId}` };
    }
    const parentRef = state.parent.issue;
    if (parentRef === null) {
      // The claim query withholds this effect until the parent reference exists, so
      // reaching here means the record vanished under us. "Not yet" is the honest
      // answer; creating a second parent from the reconciliation effect is not.
      return { kind: "transient", reason: `parent work item ${payload.parentWorkItemId} has no issue reference yet` };
    }

    const body = `${payload.body}\n\n${publicationSection(state)}`;
    return this.#write(async () => {
      const result = await this.scm.upsertIssue(toIssueUpsertInput(payload, body, parentRef));
      // The write result is recorded rather than discarded: the reconciliation is
      // still a publication, and re-recording it keeps the durable reference in step
      // with the provider's authoritative answer instead of quietly diverging.
      await publications.recordIssue(payload.parentWorkItemId, payload.marker, {
        provider: "github",
        number: result.number,
        externalId: result.id,
        url: result.url,
      });
    });
  }

  /**
   * Re-post the nightly check with the parent link and the honest publication
   * status. It runs even when publication FAILED — that is the case where a check
   * claiming a clean handover would be a lie — so it never depends on the parent
   * issue existing.
   */
  async #refreshCheck(payload: NightlyCheckRefreshPayload): Promise<ApplyResult> {
    const publications = this.publications;
    if (!publications) return unconfigured(NIGHTLY_CHECK_REFRESH_EFFECT);

    const state = await publications.publicationState(payload.reportId);
    return this.#write(() =>
      this.scm.upsertCheckRun({
        subject: payload.subject,
        externalId: payload.externalId,
        name: payload.name,
        conclusion: payload.conclusion,
        title: payload.title,
        summary: checkSummaryWithPublication(payload.summary, state),
      }),
    );
  }

  /**
   * Persist a dead letter's consequence. A failed issue effect leaves a durable,
   * human-visible hole in the work graph rather than an invisible one, and anything
   * waiting on the reference it would have produced is failed with the upstream
   * reason instead of blocking indefinitely.
   *
   * Best-effort by design: a throw here must not turn a recorded dead letter into an
   * aborted batch, so it is logged and contained.
   */
  async #recordTerminalFailure(record: OutboxRecord, reason: string): Promise<void> {
    if (record.effectType === "pull_request") await this.#recordDeliveryFailure(record, reason);

    const produces = record.produces;
    if (produces === null || !this.publications) return;
    try {
      if (produces.kind === "issue_reference") {
        // Only cascade when the failure was actually recorded. The store refuses it
        // when the item IS published — a `recordIssue` that succeeded and a
        // `markSent` that then threw reaches exactly that state — and cascading from
        // a published parent would dead-letter every child effect, withholding the
        // whole night's findings from humans for a reason that is not true.
        const recorded = await this.publications.recordPublicationFailure(produces.workItemId, reason);
        if (recorded) {
          await this.#cascadeUnobtainableReference(produces.workItemId, reason);
        } else {
          console.error(
            `outbox ${record.id}: ${produces.workItemId} is already published — recording no publication failure and not cascading`,
          );
        }
      } else {
        await this.publications.recordAttachmentFailure(produces.workItemId, reason);
      }
    } catch (err) {
      console.error(
        `outbox ${record.id}: could not record terminal publication failure: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Record that a fix proposal will never be delivered.
   *
   * A refused patch (stale preimage, a branch carrying someone else's commit) or an
   * exhausted retry budget is the case the brief calls "fails safely and remains
   * visible": the proposal moves to `delivery_failed` with the reason, the child
   * issue stays actionable, and no PR is invented. The store refuses the write when a
   * PR handle is already on record — the crash between `openPullRequest` and
   * `markSent` reaches exactly that state, and relabelling a live PR as failed would
   * abandon a pull request a human is looking at.
   */
  async #recordDeliveryFailure(record: OutboxRecord, reason: string): Promise<void> {
    const fixLifecycle = this.fixLifecycle;
    if (!fixLifecycle) return;
    // Re-parsed rather than threaded through: a payload that failed to parse is one of
    // the reasons we are here, and it has no proposal identity to record against.
    const parsed = PullRequestPayload.safeParse(record.payload);
    if (!parsed.success || parsed.data.proposalId === undefined) return;
    try {
      const recorded = await fixLifecycle.recordDeliveryFailure(parsed.data.proposalId, reason);
      if (!recorded) {
        console.error(`outbox ${record.id}: ${parsed.data.proposalId} already has a pull request — recording no delivery failure`);
      }
    } catch (err) {
      console.error(
        `outbox ${record.id}: could not record terminal delivery failure: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Cascade "this reference will never exist" through the dependency graph.
   *
   * TRANSITIVE ON PURPOSE. A failed parent orphans its children, and a child that
   * is never published orphans its attachment. Failing only the immediate
   * dependents would leave the children's publications forever "not attempted",
   * which is unsettled — and the reconciliation effects wait on SETTLED, so the
   * one effect whose whole job is to report the failure would be blocked by it.
   * Recording each orphaned work item as terminally failed both tells a human what
   * happened and settles the dependency so reconciliation proceeds.
   *
   * `seen` bounds the walk: the graph is a tree today, but a cycle must terminate
   * rather than spin.
   */
  async #cascadeUnobtainableReference(workItemId: string, reason: string): Promise<void> {
    const publications = this.publications;
    if (!publications) return;
    const queue = [workItemId];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);

      const orphaned = await this.outbox.failDependentsAwaitingReference(current, reason);
      // `issue_reference` productions first, deliberately: a child's publication row
      // is what its attachment failure is recorded against, and `update ... returning`
      // has no defined order, so relying on the store's row order would make the
      // recorded reason scan-dependent.
      for (const production of [...orphaned].sort((a, b) => rank(a.kind) - rank(b.kind))) {
        if (production.kind === "issue_reference") {
          const recorded = await publications.recordPublicationFailure(
            production.workItemId,
            `not published: ${current} could not be published (${reason})`,
          );
          // A dependent that turns out to be published already is not orphaned, so the
          // walk stops there rather than failing its own descendants.
          if (recorded) queue.push(production.workItemId);
        } else {
          await publications.recordAttachmentFailure(
            production.workItemId,
            `not attached: ${current} could not be published (${reason})`,
          );
        }
      }
    }
  }

  async #write(fn: () => Promise<unknown>): Promise<ApplyResult> {
    try {
      await fn();
      return { kind: "sent" };
    } catch (err) {
      return { kind: "transient", reason: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Cascade order: a work item's publication row before anything keyed off it. */
function rank(kind: EffectProduction["kind"]): number {
  return kind === "issue_reference" ? 0 : 1;
}

/**
 * An issue effect with no publication store wired. PERMANENT: no retry can
 * configure the deployment, and pretending success would mark a work graph
 * published that never left the process.
 */
function unconfigured(effectType: string): ApplyResult {
  return { kind: "permanent", reason: `${effectType} requires a publication store; issue publication is not configured` };
}
