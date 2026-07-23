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
 */

/** Retry budget for a transient write failure before the effect is dead-lettered. */
const MAX_ATTEMPTS = 5;

type ApplyResult = { kind: "sent" } | { kind: "permanent"; reason: string } | { kind: "transient"; reason: string };

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
      const result = await this.#apply(record);
      if (result.kind === "sent") {
        await this.outbox.markSent(record.id);
        sent += 1;
      } else if (result.kind === "permanent") {
        console.error(`outbox ${record.id}: permanent failure — dead-lettering: ${result.reason}`);
        await this.outbox.markFailed(record.id, result.reason);
      } else if (record.attempts >= MAX_ATTEMPTS) {
        console.error(`outbox ${record.id}: ${record.attempts} attempts exhausted — dead-lettering: ${result.reason}`);
        await this.outbox.markFailed(record.id, result.reason);
      } else {
        // Transient with budget left: leave pending, retry on a later pass.
        console.error(`outbox ${record.id}: transient failure (attempt ${record.attempts}), will retry: ${result.reason}`);
      }
    }
    return sent;
  }

  /** Apply one effect. Never throws — a write failure is returned as a transient result. */
  async #apply(record: { id: string; effectType: string; payload: unknown }): Promise<ApplyResult> {
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
      default:
        return { kind: "permanent", reason: `unknown effect type ${record.effectType}` };
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
