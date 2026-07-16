import type { OutboxStore } from "../persistence/outbox.js";
import type { ScmWriter } from "../providers/scm/port.js";
import { CheckRunPayload, toCheckRunInput } from "./check-run.js";
import { PullRequestPayload, toPullRequestInput } from "./pull-request.js";

/**
 * The effects component. It is the only path that performs SCM writes (ADR
 * 0001/0003). It drains the outbox and applies each effect idempotently:
 *
 *  - the SCM upsert is keyed by (subject, externalId), so re-dispatching the
 *    same effect does not create a duplicate check run;
 *  - only after the write succeeds is the row marked `sent`, so a crash between
 *    write and mark simply re-dispatches (at-least-once + idempotent = safe).
 *
 * A malformed payload is left pending (not marked sent) and surfaced, rather
 * than silently dropped.
 */
export class EffectsDispatcher {
  constructor(
    private readonly outbox: OutboxStore,
    private readonly scm: ScmWriter,
  ) {}

  /** Dispatch one batch. Returns the number of effects successfully sent. */
  async dispatchOnce(batch = 20): Promise<number> {
    const claimed = await this.outbox.claimPending(batch);
    let sent = 0;
    for (const record of claimed) {
      const applied = await this.#apply(record);
      if (applied) {
        await this.outbox.markSent(record.id);
        sent += 1;
      }
      // A record that fails to apply is left pending (not marked sent) — loud,
      // never silently dropped, and safe to retry (writes are idempotent).
    }
    return sent;
  }

  /** Apply one effect. Returns false to leave it pending (bad payload / unknown type). */
  async #apply(record: { id: string; effectType: string; payload: unknown }): Promise<boolean> {
    switch (record.effectType) {
      case "check_run": {
        const parsed = CheckRunPayload.safeParse(record.payload);
        if (!parsed.success) {
          console.error(`outbox ${record.id}: invalid check_run payload`, parsed.error.flatten());
          return false;
        }
        await this.scm.upsertCheckRun(toCheckRunInput(parsed.data));
        return true;
      }
      case "pull_request": {
        const parsed = PullRequestPayload.safeParse(record.payload);
        if (!parsed.success) {
          console.error(`outbox ${record.id}: invalid pull_request payload`, parsed.error.flatten());
          return false;
        }
        await this.scm.openPullRequest(toPullRequestInput(parsed.data));
        return true;
      }
      default:
        console.error(`outbox ${record.id}: unknown effect type ${record.effectType}`);
        return false;
    }
  }
}
