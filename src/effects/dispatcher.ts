import type { OutboxStore } from "../persistence/outbox.js";
import type { ScmWriter } from "../providers/scm/port.js";
import { CheckRunPayload, toCheckRunInput } from "./check-run.js";

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
      if (record.effectType !== "check_run") {
        throw new Error(`unknown effect type: ${record.effectType}`);
      }
      const parsed = CheckRunPayload.safeParse(record.payload);
      if (!parsed.success) {
        // Leave pending; do not mark sent. Loud, not silent.
        console.error(`outbox ${record.id}: invalid check_run payload`, parsed.error.flatten());
        continue;
      }
      await this.scm.upsertCheckRun(toCheckRunInput(parsed.data));
      await this.outbox.markSent(record.id);
      sent += 1;
    }
    return sent;
  }
}
