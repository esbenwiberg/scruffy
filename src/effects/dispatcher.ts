import type { OutboxPort, OutboxRecord } from "../persistence/outbox.js";
import type { NightlyPublicationPort } from "../persistence/publications.js";
import type { ScmWriter } from "../providers/scm/port.js";
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

  /** Apply one effect. Never throws — a write failure is returned as a transient result. */
  async #apply(record: OutboxRecord): Promise<ApplyResult> {
    switch (record.effectType) {
      case "check_run": {
        const parsed = CheckRunPayload.safeParse(record.payload);
        if (!parsed.success) return { kind: "permanent", reason: `invalid check_run payload: ${parsed.error.message}` };
        return this.#write(() => this.scm.upsertCheckRun(toCheckRunInput(parsed.data)));
      }
      case "pull_request": {
        const parsed = PullRequestPayload.safeParse(record.payload);
        if (!parsed.success) return { kind: "permanent", reason: `invalid pull_request payload: ${parsed.error.message}` };
        return this.#write(() => this.scm.openPullRequest(toPullRequestInput(parsed.data)));
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

    return this.#write(async () => {
      const result = await this.scm.upsertIssue(toIssueUpsertInput(payload, withParentLink(payload.body, parentRef)));
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
    const body = `${payload.body}\n\n${publicationSection(state)}`;
    return this.#write(() => this.scm.upsertIssue(toIssueUpsertInput(payload, body)));
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
    const produces = record.produces;
    if (produces === null || !this.publications) return;
    try {
      if (produces.kind === "issue_reference") {
        await this.publications.recordPublicationFailure(produces.workItemId, reason);
        const cascaded = await this.outbox.failDependentsAwaitingReference(produces.workItemId, reason);
        if (cascaded > 0) {
          console.error(`outbox ${record.id}: cascaded terminal failure to ${cascaded} dependent effect(s)`);
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

  async #write(fn: () => Promise<unknown>): Promise<ApplyResult> {
    try {
      await fn();
      return { kind: "sent" };
    } catch (err) {
      return { kind: "transient", reason: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * An issue effect with no publication store wired. PERMANENT: no retry can
 * configure the deployment, and pretending success would mark a work graph
 * published that never left the process.
 */
function unconfigured(effectType: string): ApplyResult {
  return { kind: "permanent", reason: `${effectType} requires a publication store; issue publication is not configured` };
}
