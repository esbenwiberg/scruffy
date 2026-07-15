import { z } from "zod";
import { SubjectRevision } from "../evidence/types.js";

/**
 * Gate-neutral evaluation run. A run is the durable unit of work: it survives
 * missed/out-of-order webhooks, retries, and process death. A webhook is a
 * prompt to reconcile a run, not the authoritative state (ADR 0003).
 */

export const GateKind = z.enum(["poison", "nightly", "release"]);
export type GateKind = z.infer<typeof GateKind>;

/**
 * Durable state machine. `pending` -> `analyzing` -> terminal. Terminal states
 * are distinguished so that supersession and infra failure are never confused
 * with a clean result:
 *  - `decided`      : a gate decision was produced and recorded.
 *  - `superseded`   : the subject head moved before this run reached a decision.
 *  - `indeterminate`: analysis could not produce a safe decision (abstained).
 */
export const RunState = z.enum([
  "pending",
  "analyzing",
  "decided",
  "superseded",
  "indeterminate",
]);
export type RunState = z.infer<typeof RunState>;

export const EvaluationRun = z.object({
  id: z.string().min(1),
  kind: GateKind,
  subject: SubjectRevision,
  /** Merge-group sha when the run evaluates a merge queue candidate. */
  mergeGroupSha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  policyVersion: z.string().min(1),
  state: RunState,
  attempt: z.number().int().nonnegative(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type EvaluationRun = z.infer<typeof EvaluationRun>;

/** A recorded state transition; the run's history is the audit trail. */
export const RunTransition = z.object({
  runId: z.string().min(1),
  from: RunState,
  to: RunState,
  reason: z.string().min(1),
  at: z.date(),
});
export type RunTransition = z.infer<typeof RunTransition>;
